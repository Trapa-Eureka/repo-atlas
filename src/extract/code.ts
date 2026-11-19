import type { Node } from "web-tree-sitter";
import type { FileFacts, ImportedName, SymbolFact } from "./facts.js";
import { looksLikeSql, tablesInSql } from "./sql.js";

const line = (node: Node): number => node.startPosition.row + 1;
const endLine = (node: Node): number => node.endPosition.row + 1;
const column = (node: Node): number => node.startPosition.column;

function unquote(text: string): string {
  return text.replace(/^[a-zA-Z]*("""|'''|["'`])/, "").replace(/("""|'''|["'`])$/, "");
}

function children(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null);
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function sniffSql(node: Node, facts: FileFacts): void {
  const text = unquote(node.text);
  if (text.length < 12 || !looksLikeSql(text)) return;
  facts.tables.push(...tablesInSql(text, line(node)));
}

function addSymbol(facts: FileFacts, symbol: SymbolFact): void {
  if (!facts.symbols.some((existing) => existing.name === symbol.name)) facts.symbols.push(symbol);
}

// ---------- TypeScript / JavaScript ----------

const SCRIPT_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const NOT_A_QUERY_BUILDER = new Set(["Array", "Buffer", "Object", "Set", "Map", "Promise", "Uint8Array", "Observable", "rxjs", "Date"]);

interface ScriptScope {
  topLevel: boolean;
  exported: boolean;
  isDefault: boolean;
  /** Set only directly inside a class body. */
  className: string | null;
  /** First and last line of the innermost class, kept through nested scopes. */
  classRange: [number, number] | null;
  /** Last line of the innermost block or function: where a name declared here stops being in scope. */
  scopeEnd: number;
}

function nested(scope: ScriptScope): ScriptScope {
  return { topLevel: false, exported: false, isDefault: false, className: null, classRange: scope.classRange, scopeEnd: scope.scopeEnd };
}

function importNames(clause: Node): ImportedName[] {
  const names: ImportedName[] = [];
  for (const part of namedChildren(clause)) {
    if (part.type === "identifier") names.push({ local: part.text, imported: "default" });
    else if (part.type === "namespace_import") {
      const local = namedChildren(part).find((child) => child.type === "identifier");
      if (local) names.push({ local: local.text, imported: "*" });
    } else if (part.type === "named_imports") {
      for (const specifier of namedChildren(part)) {
        if (specifier.type !== "import_specifier") continue;
        const imported = specifier.childForFieldName("name")?.text;
        const local = specifier.childForFieldName("alias")?.text ?? imported;
        if (imported && local) names.push({ local, imported });
      }
    }
  }
  return names;
}

function firstStringArgument(call: Node): string | null {
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  if (!first || (first.type !== "string" && first.type !== "template_string")) return null;
  const text = unquote(first.text);
  return text.includes("${") ? null : text;
}

/** The module named by `require("x")`, `import("x")` or `await import("x")`. */
function requireSpecifier(value: Node): string | null {
  const call = value.type === "await_expression" ? (namedChildren(value)[0] ?? value) : value;
  const callee = call.type === "call_expression" ? call.childForFieldName("function") : null;
  return callee?.type === "import" || (callee?.type === "identifier" && callee.text === "require") ? firstStringArgument(call) : null;
}

/** `Foo` from `: Foo` or `: Foo<T>`. Unions, arrays and built-in types say nothing useful about a class. */
function typeName(annotation: Node | null): string | null {
  const type = annotation ? namedChildren(annotation)[0] : undefined;
  const name = type?.type === "generic_type" ? type.childForFieldName("name") : type;
  // A single capital letter is a type parameter (`T`, `K`), not a class.
  return name?.type === "type_identifier" && !/^[A-Z]$/.test(name.text) ? name.text : null;
}

/** `[local, property]` for each name an object pattern takes out: `{ a, b: c, d = 1 }`. */
function patternNames(pattern: Node): [string, string][] {
  const names: [string, string][] = [];
  for (const part of namedChildren(pattern)) {
    if (part.type === "shorthand_property_identifier_pattern") names.push([part.text, part.text]);
    else if (part.type === "pair_pattern") {
      const key = part.childForFieldName("key");
      const value = part.childForFieldName("value");
      if (key?.type === "property_identifier" && value?.type === "identifier") names.push([value.text, key.text]);
    } else if (part.type === "object_assignment_pattern") {
      const left = part.childForFieldName("left");
      if (left?.type === "shorthand_property_identifier_pattern") names.push([left.text, left.text]);
    }
  }
  return names;
}

/** Every name a binding pattern declares: `x`, `{ a, b: c }`, `[p, q]`, `...rest`, `x = 1`. */
function declaredNames(pattern: Node | null): string[] {
  if (!pattern) return [];
  if (pattern.type === "identifier") return [pattern.text];
  if (pattern.type === "object_pattern") return patternNames(pattern).map(([local]) => local);
  if (pattern.type === "assignment_pattern") return declaredNames(pattern.childForFieldName("left"));
  if (pattern.type === "array_pattern" || pattern.type === "rest_pattern") return namedChildren(pattern).flatMap(declaredNames);
  return [];
}

function scriptCall(node: Node, facts: FileFacts): void {
  const callee = node.childForFieldName("function");
  if (!callee) return;
  if (callee.type === "import" || (callee.type === "identifier" && callee.text === "require")) {
    const specifier = firstStringArgument(node);
    if (specifier) facts.imports.push({ specifier, names: [], reexport: false, star: false, line: line(node) });
    return;
  }
  if (callee.type === "identifier") {
    facts.calls.push({ callee: callee.text, receiver: null, line: line(node), column: column(node) });
    return;
  }
  if (callee.type !== "member_expression") return;
  const object = callee.childForFieldName("object");
  const property = callee.childForFieldName("property");
  if (!object || !property) return;
  // `db.from("users")` and `DB.from("users")` are query builders; `Readable.from("x")`, a static method of a class, is not.
  if (property.text === "from" && !NOT_A_QUERY_BUILDER.has(object.text) && !/(?:^|\.)[A-Z][A-Z0-9_]*[a-z]\w*$/.test(object.text)) {
    const table = firstStringArgument(node);
    if (table && /^[A-Za-z_]\w*$/.test(table)) facts.tables.push({ name: table.toLowerCase(), op: "read", line: line(node) });
  }
  if (object.type === "identifier" || object.type === "this" || object.type === "super") {
    facts.calls.push({ callee: property.text, receiver: object.text, line: line(node), column: column(node) });
  } else if (object.type === "member_expression" && object.childForFieldName("object")?.type === "this") {
    const field = object.childForFieldName("property");
    if (field?.type === "property_identifier") facts.calls.push({ callee: property.text, receiver: `this.${field.text}`, line: line(node), column: column(node) });
  }
}

/**
 * Parameters. `(options: Options)` makes `options` an instance of `Options` for the whole function;
 * an untyped one is recorded too, because it hides whatever the name means outside.
 */
function scriptParameters(node: Node, facts: FileFacts, scope: ScriptScope): void {
  const range = { line: line(node), endLine: endLine(node), column: column(node) };
  const single = node.type === "arrow_function" ? node.childForFieldName("parameter") : null;
  if (single?.type === "identifier") facts.locals.push({ name: single.text, kind: "other", ...range });
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return;
  for (const parameter of namedChildren(parameters)) {
    const typed = parameter.type === "required_parameter" || parameter.type === "optional_parameter";
    const pattern = typed ? parameter.childForFieldName("pattern") : parameter;
    const type = typed && pattern?.type === "identifier" ? typeName(parameter.childForFieldName("type")) : null;
    for (const name of declaredNames(pattern)) {
      if (type) facts.locals.push({ name, kind: "instance", type, ...range });
      else facts.locals.push({ name, kind: "other", ...range });
    }
    // `constructor(private db: Db)` also declares the field `this.db`.
    const isField = typed && children(parameter).some((child) => child.type === "accessibility_modifier" || child.text === "readonly");
    if (isField && type && pattern && scope.classRange) facts.locals.push({ name: `this.${pattern.text}`, kind: "instance", type, line: scope.classRange[0], endLine: scope.classRange[1] });
  }
}

/** Records what a declared name is. Returns true when the declarator was a top-level `require()` and is fully handled. */
function scriptDeclarator(declarator: Node, facts: FileFacts, scope: ScriptScope): boolean {
  const name = declarator.childForFieldName("name");
  const value = declarator.childForFieldName("value");
  if (!name) return false;
  const range = { line: line(declarator), endLine: scope.scopeEnd, column: column(declarator) };

  // Only at the top level is a required module a binding of the whole file. Inside a function the
  // import is still recorded (by the call itself), and the name just hides outer ones.
  const specifier = value && scope.topLevel ? requireSpecifier(value) : null;
  if (specifier && (name.type === "identifier" || name.type === "object_pattern")) {
    // `require()` returns what the module exports as one value; `import()` returns its namespace.
    const whole = /^(?:await\s+)?import\b/.test(value?.text ?? "") ? "*" : "=";
    const names = name.type === "identifier" ? [{ local: name.text, imported: whole }] : patternNames(name).map(([local, property]) => ({ local, imported: property }));
    facts.imports.push({ specifier, names, reexport: false, star: false, line: line(declarator) });
    return true;
  }

  if (name.type !== "identifier") {
    const from = name.type === "object_pattern" && value?.type === "identifier" ? value.text : null;
    if (from) for (const [local, property] of patternNames(name)) facts.locals.push({ name: local, kind: "member", object: from, property, ...range });
    else for (const local of declaredNames(name)) facts.locals.push({ name: local, kind: "other", ...range });
    return false;
  }
  // A top-level function is a symbol and is found by its name. `const handler: Handler = () => {}`
  // is a function with a type, not an instance of one.
  if (value && SCRIPT_FUNCTION_VALUES.has(value.type)) {
    if (!scope.topLevel) facts.locals.push({ name: name.text, kind: "other", ...range });
    return false;
  }

  const constructed = value?.type === "new_expression" ? value.childForFieldName("constructor") : null;
  const type = constructed?.type === "identifier" ? constructed.text : typeName(declarator.childForFieldName("type"));
  const object = value?.type === "member_expression" ? value.childForFieldName("object") : null;
  const property = value?.type === "member_expression" ? value.childForFieldName("property") : null;
  if (type) facts.locals.push({ name: name.text, kind: "instance", type, ...range });
  else if (object?.type === "identifier" && property?.type === "property_identifier") {
    facts.locals.push({ name: name.text, kind: "member", object: object.text, property: property.text, ...range });
  } else facts.locals.push({ name: name.text, kind: "other", ...range });
  return false;
}

/** The members of an object literal that are a plain name: `{ a, b: c }` gives `[a, a]` and `[b, c]`. */
function objectMembers(object: Node): [string, string][] {
  const members: [string, string][] = [];
  for (const member of namedChildren(object)) {
    if (member.type === "shorthand_property_identifier") members.push([member.text, member.text]);
    else if (member.type === "pair") {
      const key = member.childForFieldName("key");
      const value = member.childForFieldName("value");
      if (key?.type === "property_identifier" && value?.type === "identifier") members.push([key.text, value.text]);
    }
  }
  return members;
}

/**
 * What a module hands out as one value: `export default <value>` or `module.exports = <value>`.
 * A name becomes an alias, a named function becomes a symbol, and each member of an object literal
 * that is a plain name is reachable as `default.<key>`. With `named`, those members are also
 * exports of their own (CommonJS). Functions written inside the object are not symbols.
 */
function exportedValue(value: Node, facts: FileFacts, named: boolean): void {
  if (value.type === "identifier") {
    facts.exports.push({ exported: "default", local: value.text });
  } else if (SCRIPT_FUNCTION_VALUES.has(value.type) || value.type === "class") {
    const name = value.childForFieldName("name")?.text;
    if (name) addSymbol(facts, { name, kind: value.type === "class" ? "class" : "function", line: line(value), endLine: endLine(value), exported: true, isDefault: true });
  } else if (value.type === "object") {
    for (const [key, local] of objectMembers(value)) {
      facts.exports.push({ exported: `default.${key}`, local });
      if (named) facts.exports.push({ exported: key, local });
    }
  }
}

/** `module.exports = x`, `exports.name = x`, `module.exports.name = x`, and chains of them. */
function commonJsExport(assignment: Node, facts: FileFacts): void {
  const targets: string[] = [];
  let value: Node | null = assignment;
  while (value?.type === "assignment_expression") {
    const left: Node | null = value.childForFieldName("left");
    if (left) targets.push(left.text);
    value = value.childForFieldName("right");
  }
  if (!value) return;
  for (const target of targets) {
    // `module.exports = require("./lib")` hands on everything the other module exports.
    const passedOn = target === "module.exports" ? requireSpecifier(value) : null;
    if (passedOn) facts.imports.push({ specifier: passedOn, names: [], reexport: true, star: true, line: line(assignment) });
    else if (target === "module.exports") exportedValue(value, facts, true);
    const key = /^(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)$/.exec(target)?.[1];
    if (!key) continue;
    if (value.type === "identifier") {
      facts.exports.push({ exported: key, local: value.text });
    } else if (SCRIPT_FUNCTION_VALUES.has(value.type)) {
      addSymbol(facts, { name: key, kind: "function", line: line(value), endLine: endLine(value), exported: true, isDefault: false });
    }
  }
}

function walkScript(node: Node, facts: FileFacts, scope: ScriptScope): void {
  scriptParameters(node, facts, scope);

  switch (node.type) {
    case "import_statement": {
      const source = node.childForFieldName("source");
      if (!source) return;
      const clause = namedChildren(node).find((child) => child.type === "import_clause");
      facts.imports.push({
        specifier: unquote(source.text),
        names: clause ? importNames(clause) : [],
        reexport: false,
        star: false,
        line: line(node),
      });
      return;
    }
    case "export_statement": {
      const source = node.childForFieldName("source");
      const clause = namedChildren(node).find((child) => child.type === "export_clause");
      const names: ImportedName[] = [];
      for (const specifier of clause ? namedChildren(clause) : []) {
        const imported = specifier.childForFieldName("name")?.text;
        const local = specifier.childForFieldName("alias")?.text ?? imported;
        if (imported && local) names.push({ local, imported });
      }
      if (source) {
        facts.imports.push({ specifier: unquote(source.text), names, reexport: true, star: !clause, line: line(node) });
        return;
      }
      // `export { a as b }` with no source: `b` stands for the local `a`, which may itself be an import.
      for (const name of names) facts.exports.push({ exported: name.local, local: name.imported });
      const isDefault = children(node).some((child) => child.type === "default");
      const value = node.childForFieldName("value");
      if (isDefault && value && scope.topLevel) exportedValue(value, facts, false);
      for (const child of namedChildren(node)) walkScript(child, facts, { ...scope, exported: scope.topLevel, isDefault });
      return;
    }
    case "expression_statement": {
      const expression = namedChildren(node)[0];
      if (scope.topLevel && expression?.type === "assignment_expression") commonJsExport(expression, facts);
      break;
    }
    case "function_declaration":
    case "generator_function_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.topLevel) {
        addSymbol(facts, { name, kind: "function", line: line(node), endLine: endLine(node), exported: scope.exported, isDefault: scope.isDefault });
      } else if (name) {
        facts.locals.push({ name, kind: "other", line: line(node), endLine: scope.scopeEnd, column: column(node) });
      }
      break;
    }
    case "for_in_statement":
    case "catch_clause": {
      // `for (const item of items)`, `catch (error)`: the name belongs to the loop or the handler.
      const declared = node.childForFieldName(node.type === "catch_clause" ? "parameter" : "left");
      for (const name of declaredNames(declared)) facts.locals.push({ name, kind: "other", line: line(node), endLine: endLine(node), column: column(node) });
      break;
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.topLevel) {
        const heritage = namedChildren(node).find((child) => child.type === "class_heritage");
        const clause = heritage ? namedChildren(heritage)[0] : undefined;
        const parent = clause?.type === "extends_clause" ? clause.childForFieldName("value") : clause;
        const symbol: SymbolFact = { name, kind: "class", line: line(node), endLine: endLine(node), exported: scope.exported, isDefault: scope.isDefault };
        if (parent?.type === "identifier") symbol.extends = parent.text;
        addSymbol(facts, symbol);
        const inside: ScriptScope = { topLevel: false, exported: false, isDefault: false, className: name, classRange: [line(node), endLine(node)], scopeEnd: endLine(node) };
        for (const child of namedChildren(node)) walkScript(child, facts, inside);
        return;
      }
      break;
    }
    case "method_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.className) {
        addSymbol(facts, { name: `${scope.className}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: false, isDefault: false });
      }
      break;
    }
    case "public_field_definition":
    case "field_definition": {
      const name = (node.childForFieldName("name") ?? node.childForFieldName("property"))?.text;
      const value = node.childForFieldName("value");
      if (!name || !scope.className || !scope.classRange) break;
      // `run = () => {}` is a method in all but syntax.
      if (value && SCRIPT_FUNCTION_VALUES.has(value.type)) {
        addSymbol(facts, { name: `${scope.className}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: false, isDefault: false });
      }
      const constructed = value?.type === "new_expression" ? value.childForFieldName("constructor") : null;
      const type = constructed?.type === "identifier" ? constructed.text : typeName(node.childForFieldName("type"));
      if (type) facts.locals.push({ name: `this.${name}`, kind: "instance", type, line: scope.classRange[0], endLine: scope.classRange[1] });
      break;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      for (const declarator of namedChildren(node)) {
        const name = declarator.childForFieldName("name");
        const value = declarator.childForFieldName("value");
        if (scope.topLevel && name?.type === "identifier" && value && SCRIPT_FUNCTION_VALUES.has(value.type)) {
          addSymbol(facts, { name: name.text, kind: "function", line: line(node), endLine: endLine(node), exported: scope.exported, isDefault: false });
        }
        if (declarator.type !== "variable_declarator" || !scriptDeclarator(declarator, facts, scope)) walkScript(declarator, facts, nested(scope));
      }
      return;
    }
    case "call_expression":
      scriptCall(node, facts);
      break;
    case "new_expression": {
      const constructor = node.childForFieldName("constructor");
      if (constructor?.type === "identifier") facts.calls.push({ callee: constructor.text, receiver: null, line: line(node), column: column(node) });
      break;
    }
    case "jsx_opening_element":
    case "jsx_self_closing_element": {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier" && /^[A-Z]/.test(name.text)) facts.calls.push({ callee: name.text, receiver: null, line: line(node), column: column(node) });
      break;
    }
    case "string":
    case "template_string":
      sniffSql(node, facts);
      break;
    default:
      break;
  }

  // The root is `program`, or `ERROR` when the grammar could not parse the whole file: what it did parse still counts.
  let inner = node.parent === null || node.type === "class_body" ? scope : nested(scope);
  // A block, or anything that takes parameters, starts a scope of its own.
  if (node.type === "statement_block" || node.childForFieldName("parameters")) inner = { ...inner, scopeEnd: endLine(node) };
  // A class that is not a symbol (nested, or an expression) has fields of its own: they are not the outer class's.
  if (node.type === "class" || node.type === "class_declaration" || node.type === "abstract_class_declaration") inner = { ...inner, classRange: null };
  for (const child of namedChildren(node)) walkScript(child, facts, inner);
}

export function extractScript(root: Node, facts: FileFacts): void {
  walkScript(root, facts, { topLevel: true, exported: false, isDefault: false, className: null, classRange: null, scopeEnd: endLine(root) });
}

// ---------- Python ----------

interface PythonScope {
  topLevel: boolean;
  className: string | null;
}

function pythonImportedName(node: Node): { name: string; alias: string | null } | null {
  if (node.type === "dotted_name") return { name: node.text, alias: null };
  if (node.type === "aliased_import") {
    const name = node.childForFieldName("name")?.text;
    return name ? { name, alias: node.childForFieldName("alias")?.text ?? null } : null;
  }
  return null;
}

function walkPython(node: Node, facts: FileFacts, scope: PythonScope): void {
  switch (node.type) {
    case "import_statement": {
      for (const child of namedChildren(node)) {
        const imported = pythonImportedName(child);
        if (!imported) continue;
        const local = imported.alias ?? imported.name;
        facts.imports.push({ specifier: imported.name, names: [{ local, imported: "*" }], reexport: false, star: false, line: line(node) });
      }
      return;
    }
    case "import_from_statement": {
      const moduleName = node.childForFieldName("module_name");
      if (!moduleName) return;
      const names: ImportedName[] = [];
      for (const child of node.childrenForFieldName("name")) {
        const imported = child ? pythonImportedName(child) : null;
        if (imported) names.push({ local: imported.alias ?? imported.name, imported: imported.name });
      }
      const star = namedChildren(node).some((child) => child.type === "wildcard_import");
      facts.imports.push({ specifier: moduleName.text, names, reexport: false, star, line: line(node) });
      return;
    }
    case "function_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.className) {
        addSymbol(facts, { name: `${scope.className}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: false, isDefault: false });
      } else if (name && scope.topLevel) {
        addSymbol(facts, { name, kind: "function", line: line(node), endLine: endLine(node), exported: !name.startsWith("_"), isDefault: false });
      }
      for (const child of namedChildren(node)) walkPython(child, facts, { topLevel: false, className: null });
      return;
    }
    case "class_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.topLevel) {
        addSymbol(facts, { name, kind: "class", line: line(node), endLine: endLine(node), exported: !name.startsWith("_"), isDefault: false });
        const body = node.childForFieldName("body");
        for (const child of namedChildren(node)) {
          walkPython(child, facts, child.id === body?.id ? { topLevel: false, className: name } : { topLevel: false, className: null });
        }
        return;
      }
      break;
    }
    case "call": {
      const callee = node.childForFieldName("function");
      if (callee?.type === "identifier") {
        facts.calls.push({ callee: callee.text, receiver: null, line: line(node) });
      } else if (callee?.type === "attribute") {
        const object = callee.childForFieldName("object");
        const attribute = callee.childForFieldName("attribute");
        if (object?.type === "identifier" && attribute) facts.calls.push({ callee: attribute.text, receiver: object.text, line: line(node) });
      }
      break;
    }
    case "assignment": {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.text === "__tablename__" && right?.type === "string") {
        facts.tables.push({ name: unquote(right.text).toLowerCase(), op: "define", line: line(node) });
      }
      break;
    }
    case "string":
      sniffSql(node, facts);
      break;
    default:
      break;
  }

  const passesScope = node.type === "module" || node.type === "decorated_definition" || (node.type === "block" && scope.className !== null);
  const inner = passesScope ? scope : node.type === "block" || node.type === "if_statement" || node.type === "try_statement" ? { ...scope, className: null } : { topLevel: false, className: null };
  for (const child of namedChildren(node)) walkPython(child, facts, inner);
}

export function extractPython(root: Node, facts: FileFacts): void {
  walkPython(root, facts, { topLevel: true, className: null });
}
