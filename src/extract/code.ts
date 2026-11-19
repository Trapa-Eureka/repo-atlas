import type { Node } from "web-tree-sitter";
import type { FileFacts, ImportFact, ImportedName, SymbolFact } from "./facts.js";
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
  // A `case` clause counts too: a name declared in one stops at the end of the clause for our purposes.
  if (node.type === "statement_block" || node.type === "switch_case" || node.type === "switch_default" || node.childForFieldName("parameters")) inner = { ...inner, scopeEnd: endLine(node) };
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

// ---------- Go ----------

interface GoScope {
  /** Import alias → the import it stands for, to note which names of the package are used. */
  packages: Map<string, ImportFact>;
  /** Last line of the innermost block or function. */
  scopeEnd: number;
}

/** `T` from `T`, `*T`, `T[K]`; `pkg.T` from `*pkg.T`. Slices, maps and function types say nothing about one type. */
function goTypeName(type: Node | null | undefined): string | null {
  if (!type) return null;
  if (type.type === "pointer_type" || type.type === "parenthesized_type") return goTypeName(namedChildren(type)[0]);
  if (type.type === "generic_type") return goTypeName(type.childForFieldName("type"));
  // A single capital letter is a type parameter (`T`, `K`), not a type of the package.
  return (type.type === "type_identifier" && !/^[A-Z]$/.test(type.text)) || type.type === "qualified_type" ? type.text : null;
}

/** The type a value is built as: `T{...}`, `&T{...}`, `pkg.T{...}`. */
function goConstructedType(value: Node | undefined): string | null {
  const literal = value?.type === "unary_expression" ? value.childForFieldName("operand") : value;
  return literal?.type === "composite_literal" ? goTypeName(literal.childForFieldName("type")) : null;
}

/** The name a package is used under when the import gives none: the last path segment, minus a version. */
function goPackageName(path: string): string {
  const segments = path.split("/").filter((segment) => !/^v\d+$/.test(segment));
  return (segments[segments.length - 1] ?? path).replace(/\.v\d+$/, "");
}

function goParameters(list: Node | null, owner: Node, facts: FileFacts): void {
  for (const parameter of list ? namedChildren(list) : []) {
    const type = parameter.type === "parameter_declaration" ? goTypeName(parameter.childForFieldName("type")) : null;
    for (const name of namedChildren(parameter)) {
      if (name.type !== "identifier") continue;
      const range = { line: line(owner), endLine: endLine(owner), column: column(owner) };
      if (type) facts.locals.push({ name: name.text, kind: "instance", type, ...range });
      else facts.locals.push({ name: name.text, kind: "other", ...range });
    }
  }
}

/** `a, b := x, y`, `var a T`, `var a = T{}`: an instance when the type is written, otherwise just a name that hides outer ones. */
function goDeclared(names: Node[], type: string | null, values: Node[], at: Node, scope: GoScope, facts: FileFacts): void {
  // A name declared in the header of `if`, `for` or `switch` lives only as long as that statement.
  const holder = at.parent?.type === "for_clause" ? at.parent.parent : at.parent;
  const inHeader = holder && holder.type !== "statement_list" && holder.type !== "block" && holder.type !== "var_declaration" && holder.type !== "var_spec_list";
  names.forEach((name, index) => {
    if (name.type !== "identifier" || name.text === "_") return;
    const range = { line: line(at), endLine: inHeader ? endLine(holder) : scope.scopeEnd, column: column(at) };
    const known = type ?? (values.length === names.length ? goConstructedType(values[index]) : null);
    if (known) facts.locals.push({ name: name.text, kind: "instance", type: known, ...range });
    else facts.locals.push({ name: name.text, kind: "other", ...range });
  });
}

const GO_SCOPES = new Set(["block", "function_declaration", "method_declaration", "func_literal", "expression_case", "default_case", "type_case", "communication_case"]);

function walkGo(node: Node, facts: FileFacts, scope: GoScope): void {
  switch (node.type) {
    case "package_clause":
      facts.package = namedChildren(node)[0]?.text;
      return;
    case "const_spec":
    case "var_spec": {
      const names = node.childrenForFieldName("name").filter((name): name is Node => name !== null && name.text !== "_");
      // Package-level constants and variables are not symbols, but they place their users on this file.
      const packageLevel = node.parent?.parent?.type === "source_file" || node.parent?.parent?.parent?.type === "source_file";
      if (packageLevel) for (const name of names) facts.exports.push({ exported: name.text, local: name.text });
      const value = node.childForFieldName("value");
      if (node.type === "var_spec") goDeclared(names, goTypeName(node.childForFieldName("type")), value ? namedChildren(value) : [], node, scope, facts);
      break;
    }
    case "import_spec": {
      const path = node.childForFieldName("path");
      if (!path) return;
      const specifier = unquote(path.text);
      const given = node.childForFieldName("name");
      const alias = given ? given.text : goPackageName(specifier);
      const named = alias !== "_" && alias !== ".";
      const fact: ImportFact = { specifier, names: named ? [{ local: alias, imported: "*" }] : [], reexport: false, star: alias === ".", line: line(node), members: [] };
      facts.imports.push(fact);
      if (named) scope.packages.set(alias, fact);
      return;
    }
    case "function_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name) addSymbol(facts, { name, kind: "function", line: line(node), endLine: endLine(node), exported: /^[A-Z]/.test(name), isDefault: false });
      goParameters(node.childForFieldName("parameters"), node, facts);
      goParameters(node.childForFieldName("result"), node, facts);
      break;
    }
    case "method_declaration": {
      const name = node.childForFieldName("name")?.text;
      const receiver = node.childForFieldName("receiver");
      const owner = goTypeName(receiver ? namedChildren(receiver)[0]?.childForFieldName("type") : null);
      if (name && owner) addSymbol(facts, { name: `${owner}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: /^[A-Z]/.test(name), isDefault: false });
      goParameters(receiver, node, facts);
      goParameters(node.childForFieldName("parameters"), node, facts);
      goParameters(node.childForFieldName("result"), node, facts);
      break;
    }
    case "func_literal":
      goParameters(node.childForFieldName("parameters"), node, facts);
      goParameters(node.childForFieldName("result"), node, facts);
      break;
    case "type_spec": {
      const name = node.childForFieldName("name")?.text;
      const type = node.childForFieldName("type");
      if (!name || node.parent?.parent?.type !== "source_file") break;
      const symbol: SymbolFact = { name, kind: "class", line: line(node), endLine: endLine(node), exported: /^[A-Z]/.test(name), isDefault: false };
      const list = type?.type === "struct_type" ? namedChildren(type).find((child) => child.type === "field_declaration_list") : undefined;
      for (const field of list ? namedChildren(list) : []) {
        const fieldType = goTypeName(field.childForFieldName("type"));
        if (!fieldType) continue;
        const names = namedChildren(field).filter((child) => child.type === "field_identifier");
        // A field with no name is an embedded type: its methods are promoted to this one.
        if (names.length === 0) (symbol.embeds ??= []).push(fieldType);
        for (const field of names) (symbol.fields ??= {})[field.text] = fieldType;
      }
      addSymbol(facts, symbol);
      break;
    }
    case "short_var_declaration": {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      goDeclared(left ? namedChildren(left) : [], null, right ? namedChildren(right) : [], node, scope, facts);
      break;
    }
    case "range_clause": {
      const left = node.childForFieldName("left");
      goDeclared(left ? namedChildren(left) : [], null, [], node, scope, facts);
      break;
    }
    case "call_expression": {
      const callee = node.childForFieldName("function");
      const at = { line: line(node), column: column(node) };
      if (callee?.type === "identifier") facts.calls.push({ callee: callee.text, receiver: null, ...at });
      if (callee?.type !== "selector_expression") break;
      const operand = callee.childForFieldName("operand");
      const field = callee.childForFieldName("field");
      if (!field) break;
      if (operand?.type === "identifier") facts.calls.push({ callee: field.text, receiver: operand.text, ...at });
      else if (operand?.type === "selector_expression" && operand.childForFieldName("operand")?.type === "identifier") {
        facts.calls.push({ callee: field.text, receiver: operand.text, ...at });
      }
      break;
    }
    case "selector_expression":
    case "qualified_type": {
      // `pkg.Name`, called or not: note which names of an imported package this file uses.
      const owner = node.childForFieldName(node.type === "qualified_type" ? "package" : "operand");
      const member = node.childForFieldName(node.type === "qualified_type" ? "name" : "field");
      const used = owner && member ? scope.packages.get(owner.text)?.members : undefined;
      if (used && member && !used.includes(member.text)) used.push(member.text);
      break;
    }
    case "interpreted_string_literal":
    case "raw_string_literal":
      sniffSql(node, facts);
      return;
    default:
      break;
  }

  const opensScope = GO_SCOPES.has(node.type);
  const inner = opensScope ? { ...scope, scopeEnd: endLine(node) } : scope;
  for (const child of namedChildren(node)) walkGo(child, facts, inner);
}

export function extractGo(root: Node, facts: FileFacts): void {
  walkGo(root, facts, { packages: new Map(), scopeEnd: endLine(root) });
}

// ---------- Java ----------

interface JavaScope {
  /** The class, interface, enum or record being walked, qualified by the ones around it: `Outer.Inner`. */
  owner: string | null;
  ownerRange: [number, number] | null;
  /** Last line of the innermost block or method. */
  scopeEnd: number;
  /** Inside the body of an anonymous class. */
  anonymous?: boolean;
}

/** `Repo` from `Repo`, `Repo<T>`, `a.b.Repo`. Arrays and primitives say nothing about one class. */
function javaTypeName(type: Node | null | undefined): string | null {
  if (!type) return null;
  if (type.type === "generic_type") return javaTypeName(namedChildren(type)[0]);
  // A single capital letter is a type parameter (`T`, `E`), not a class.
  return (type.type === "type_identifier" && !/^[A-Z]$/.test(type.text)) || type.type === "scoped_type_identifier" ? type.text.replace(/\s+/g, "") : null;
}

function javaTypeList(node: Node | null | undefined): string[] {
  const list = node ? namedChildren(node).find((child) => child.type === "type_list") : undefined;
  return (list ? namedChildren(list) : []).map((type) => javaTypeName(type)).filter((name): name is string => name !== null);
}

/** A name with a class written as its type: an instance of it between `line` and `endLine`. `var` takes the type from `new T()`. */
function javaDeclared(name: Node | null, type: Node | null, value: Node | null, range: { line: number; endLine: number; column: number }, facts: FileFacts): void {
  if (name?.type !== "identifier") return;
  const written = type?.text === "var" ? (value?.type === "object_creation_expression" ? javaTypeName(value.childForFieldName("type")) : null) : javaTypeName(type);
  if (written) facts.locals.push({ name: name.text, kind: "instance", type: written, ...range });
  else facts.locals.push({ name: name.text, kind: "other", ...range });
}

function javaUse(name: string, node: Node, facts: FileFacts): void {
  if (/^[A-Z]$/.test(name)) return;
  const uses = (facts.uses ??= []);
  if (!uses.some((use) => use.name === name)) uses.push({ name, line: line(node) });
}

const JAVA_SCOPES = new Set(["block", "constructor_body", "method_declaration", "constructor_declaration", "lambda_expression", "switch_block_statement_group", "switch_rule"]);

function walkJava(node: Node, facts: FileFacts, scope: JavaScope): void {
  const here = { line: line(node), endLine: endLine(node), column: column(node) };
  switch (node.type) {
    case "package_declaration":
      facts.package = namedChildren(node).find((child) => child.type === "scoped_identifier" || child.type === "identifier")?.text;
      return;
    case "import_declaration": {
      const path = namedChildren(node).find((child) => child.type === "scoped_identifier" || child.type === "identifier")?.text;
      if (!path) return;
      const star = namedChildren(node).some((child) => child.type === "asterisk");
      const isStatic = children(node).some((child) => child.type === "static");
      const last = path.slice(path.lastIndexOf(".") + 1);
      // `import static a.Util.help` names a member of the class `a.Util`; the other forms name a class or a package.
      const specifier = isStatic && !star ? path.slice(0, Math.max(0, path.lastIndexOf("."))) : path;
      const fact: ImportFact = { specifier, names: star ? [] : [{ local: last, imported: last }], reexport: false, star, line: line(node) };
      if (isStatic) fact.static = true;
      facts.imports.push(fact);
      return;
    }
    case "class_declaration":
    case "interface_declaration":
    case "enum_declaration":
    case "record_declaration":
    case "annotation_type_declaration": {
      const name = node.childForFieldName("name")?.text;
      // A class declared inside an anonymous class has no name anyone else can use.
      if (!name || scope.anonymous) break;
      const qualified = scope.owner ? `${scope.owner}.${name}` : name;
      const symbol: SymbolFact = { name: qualified, kind: "class", line: line(node), endLine: endLine(node), exported: /\bpublic\b/.test(node.child(0)?.text ?? ""), isDefault: false };
      const parent = javaTypeName(namedChildren(node.childForFieldName("superclass") ?? node)[0]);
      if (node.childForFieldName("superclass") && parent) symbol.extends = parent;
      const interfaces = [...javaTypeList(node.childForFieldName("interfaces")), ...javaTypeList(namedChildren(node).find((child) => child.type === "extends_interfaces"))];
      if (interfaces.length > 0) symbol.embeds = interfaces;
      addSymbol(facts, symbol);

      // `@Table(name = "users")` on an entity names the table it is stored in.
      const modifiers = namedChildren(node).find((child) => child.type === "modifiers");
      for (const annotation of modifiers ? namedChildren(modifiers) : []) {
        if (annotation.type !== "annotation" || annotation.childForFieldName("name")?.text !== "Table") continue;
        const pair = namedChildren(annotation.childForFieldName("arguments") ?? annotation).find((child) => child.type === "element_value_pair" && child.childForFieldName("key")?.text === "name");
        const table = pair?.childForFieldName("value");
        if (table?.type === "string_literal") facts.tables.push({ name: unquote(table.text).toLowerCase(), op: "define", line: line(annotation) });
      }

      const inside: JavaScope = { owner: qualified, ownerRange: [line(node), endLine(node)], scopeEnd: endLine(node) };
      // The components of a record are its fields.
      for (const component of namedChildren(node.childForFieldName("parameters") ?? node).filter((child) => child.type === "formal_parameter")) {
        const range = { line: line(node), endLine: endLine(node), column: column(node) };
        javaDeclared(component.childForFieldName("name"), component.childForFieldName("type"), null, range, facts);
      }
      for (const child of namedChildren(node)) walkJava(child, facts, inside);
      return;
    }
    case "field_declaration": {
      if (!scope.ownerRange) break;
      const range = { line: scope.ownerRange[0], endLine: scope.ownerRange[1], column: 0 };
      for (const declarator of namedChildren(node).filter((child) => child.type === "variable_declarator")) {
        const name = declarator.childForFieldName("name");
        javaDeclared(name, node.childForFieldName("type"), declarator.childForFieldName("value"), range, facts);
        const type = javaTypeName(node.childForFieldName("type"));
        if (name && type) facts.locals.push({ name: `this.${name.text}`, kind: "instance", type, ...range });
      }
      break;
    }
    case "method_declaration":
    case "constructor_declaration":
    case "compact_constructor_declaration":
    case "lambda_expression": {
      const name = node.childForFieldName("name")?.text;
      if (node.type === "method_declaration" && name && scope.owner) {
        addSymbol(facts, { name: `${scope.owner}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: false, isDefault: false });
      }
      const parameters = node.childForFieldName("parameters");
      if (parameters?.type === "identifier") facts.locals.push({ name: parameters.text, kind: "other", ...here });
      for (const parameter of parameters ? namedChildren(parameters) : []) {
        if (parameter.type === "identifier") facts.locals.push({ name: parameter.text, kind: "other", ...here });
        else javaDeclared(parameter.childForFieldName("name"), parameter.childForFieldName("type"), null, here, facts);
      }
      break;
    }
    case "local_variable_declaration":
      for (const declarator of namedChildren(node).filter((child) => child.type === "variable_declarator")) {
        javaDeclared(declarator.childForFieldName("name"), node.childForFieldName("type"), declarator.childForFieldName("value"), { ...here, endLine: scope.scopeEnd }, facts);
      }
      break;
    case "enhanced_for_statement":
    case "resource":
      javaDeclared(node.childForFieldName("name"), node.childForFieldName("type"), node.childForFieldName("value"), node.type === "resource" ? { ...here, endLine: scope.scopeEnd } : here, facts);
      break;
    case "catch_clause": {
      const parameter = namedChildren(node).find((child) => child.type === "catch_formal_parameter");
      const type = parameter ? namedChildren(parameter).find((child) => child.type === "catch_type") : undefined;
      javaDeclared(parameter?.childForFieldName("name") ?? null, type ? (namedChildren(type)[0] ?? null) : null, null, here, facts);
      break;
    }
    case "method_invocation": {
      const name = node.childForFieldName("name")?.text;
      const object = node.childForFieldName("object");
      const at = { line: line(node), column: column(node) };
      if (!name) break;
      const implicit = !object || object.type === "this" || object.type === "super";
      if (implicit && scope.anonymous) break;
      if (!object) facts.calls.push({ callee: name, receiver: null, ...at });
      else if (object.type === "identifier" || object.type === "this" || object.type === "super") {
        facts.calls.push({ callee: name, receiver: object.text, ...at });
        // `Labels.format()`: a capitalised receiver may be a class that is used without being imported.
        if (object.type === "identifier" && /^[A-Z]/.test(object.text)) javaUse(object.text, object, facts);
      } else if (object.type === "field_access" && object.childForFieldName("object")?.type === "this") {
        const field = object.childForFieldName("field");
        if (field) facts.calls.push({ callee: name, receiver: `this.${field.text}`, ...at });
      }
      break;
    }
    case "object_creation_expression": {
      const type = javaTypeName(node.childForFieldName("type"));
      if (type) facts.calls.push({ callee: type, receiver: "new", line: line(node), column: column(node) });
      break;
    }
    case "annotation":
      // `@Query("select o from Order o")` is JPQL: it names entity classes, not tables, unless it is marked native.
      if (/^(?:Query|NamedQuery)$/.test(node.childForFieldName("name")?.text ?? "") && !/nativeQuery\s*=\s*true/.test(node.text)) return;
      break;
    case "type_identifier":
      javaUse(node.text, node, facts);
      return;
    case "scoped_type_identifier":
      javaUse(node.text.replace(/\s+/g, ""), node, facts);
      return;
    case "string_literal":
      sniffSql(node, facts);
      return;
    default:
      break;
  }

  let inner = JAVA_SCOPES.has(node.type) ? { ...scope, scopeEnd: endLine(node) } : scope;
  // The body of `new Foo() { ... }` is a class of its own with no name: its fields are its own, its
  // methods are not symbols, and what an unqualified call in it means depends on `Foo`, which may not be in this file.
  if (node.type === "class_body" && node.parent?.type === "object_creation_expression") {
    inner = { owner: null, ownerRange: [line(node), endLine(node)], scopeEnd: endLine(node), anonymous: true };
  }
  for (const child of namedChildren(node)) walkJava(child, facts, inner);
}

export function extractJava(root: Node, facts: FileFacts): void {
  walkJava(root, facts, { owner: null, ownerRange: null, scopeEnd: endLine(root) });
}

// ---------- Rust ----------

interface RustScope {
  /** The type of the `impl` block or the trait being walked: what `self` is, and what methods belong to. */
  owner: string | null;
  inFunction: boolean;
  /** Last line of the innermost block or function. */
  scopeEnd: number;
  /** Type parameter → the trait it is bound by: `T` in `fn f<T: Repo>(t: T)` stands for `Repo`. */
  bounds: Map<string, string>;
  /** How many `mod name { ... }` blocks of this file are around: inside one, `super` is the file itself. */
  inline: number;
}

/** A path as seen from the file, when it is written inside inline modules: each `super` that only leaves an inline module becomes `self`. */
function rustFromFile(path: string[], inline: number): string[] {
  let leaving = 0;
  while (leaving < inline && path[leaving] === "super") leaving++;
  return leaving === 0 ? path : ["self", ...path.slice(leaving)];
}

const RUST_POINTERS = new Set(["Box", "Rc", "Arc"]);

/** The type a method call on a value of this type goes to: through `&`, `Box`, `Rc`, `Arc`, `dyn` and `impl`. */
function rustTypeName(type: Node | null | undefined, bounds: Map<string, string>): string | null {
  if (!type) return null;
  if (type.type === "type_identifier") return bounds.get(type.text) ?? (/^[A-Z]$/.test(type.text) ? null : type.text);
  if (type.type === "scoped_type_identifier") return type.text.replace(/\s+/g, "");
  if (type.type === "reference_type" || type.type === "pointer_type") return rustTypeName(type.childForFieldName("type"), bounds);
  if (type.type === "dynamic_type" || type.type === "abstract_type") return rustTypeName(type.childForFieldName("trait"), bounds);
  if (type.type === "generic_type") {
    const base = type.childForFieldName("type");
    if (!RUST_POINTERS.has(base?.text ?? "")) return rustTypeName(base, bounds);
    const argumentList = type.childForFieldName("type_arguments");
    return rustTypeName(argumentList ? namedChildren(argumentList)[0] : null, bounds);
  }
  return null;
}

/** Every `use` path under a use tree: `a::{b, c::D as E, self}` and `a::*`. */
function rustUses(node: Node, prefix: string[]): { path: string[]; local: string | null; star: boolean }[] {
  const segments = (path: Node | null): string[] => (path ? path.text.replace(/\s+/g, "").split("::").filter(Boolean) : []);
  switch (node.type) {
    case "identifier":
    case "crate":
    case "super":
    case "scoped_identifier": {
      const path = [...prefix, ...segments(node)];
      return [{ path, local: path[path.length - 1] ?? null, star: false }];
    }
    case "self":
      return [{ path: prefix, local: prefix[prefix.length - 1] ?? null, star: false }];
    case "use_as_clause": {
      const path = [...prefix, ...segments(node.childForFieldName("path"))];
      return [{ path, local: node.childForFieldName("alias")?.text ?? null, star: false }];
    }
    case "use_wildcard":
      return [{ path: [...prefix, ...segments(namedChildren(node)[0] ?? null)], local: null, star: true }];
    case "scoped_use_list": {
      const list = node.childForFieldName("list");
      const path = [...prefix, ...segments(node.childForFieldName("path"))];
      return list ? namedChildren(list).flatMap((item) => rustUses(item, path)) : [];
    }
    case "use_list":
      return namedChildren(node).flatMap((item) => rustUses(item, prefix));
    default:
      return [];
  }
}

/** The names a pattern binds: `x`, `(a, b)`, `Some(v)`, `Point { x, y }`. The constructor's own name is not one of them. */
function rustBound(pattern: Node | null): string[] {
  if (!pattern) return [];
  if (pattern.type === "identifier") return [pattern.text];
  const constructor = pattern.childForFieldName("type");
  return namedChildren(pattern).filter((child) => child.id !== constructor?.id).flatMap(rustBound);
}

function rustOthers(pattern: Node | null, range: { line: number; endLine: number; column: number }, facts: FileFacts): void {
  for (const name of rustBound(pattern)) if (name !== "_") facts.locals.push({ name, kind: "other", ...range });
}

/** The type a `let` gives its name when it is written out: an annotation, `T { .. }`, or `T::name(..)` for a function that returns a `T`. */
function rustLetType(node: Node, bounds: Map<string, string>): string | null {
  const annotated = rustTypeName(node.childForFieldName("type"), bounds);
  if (annotated) return annotated;
  let value = node.childForFieldName("value");
  if (value?.type === "try_expression" || value?.type === "await_expression") value = namedChildren(value)[0] ?? null;
  if (value?.type === "struct_expression") return rustTypeName(value.childForFieldName("name"), bounds) ?? value.childForFieldName("name")?.text ?? null;
  const callee = value?.type === "call_expression" ? value.childForFieldName("function") : null;
  // Any `T::name()` may build a `T`. Whether it does is settled when linking, from what `name` returns.
  if (callee?.type !== "scoped_identifier") return null;
  const path = callee.childForFieldName("path")?.text.replace(/\s+/g, "") ?? "";
  return /(?:^|::)[A-Z]\w*$/.test(path) ? path : null;
}

/** `new` for `let x = T::new()`, `?new` for `let x = T::new()?`, null when the type was written or built with a struct literal. */
function rustLetConstructor(node: Node): string | null {
  if (node.childForFieldName("type")) return null;
  const value = node.childForFieldName("value");
  const tried = value?.type === "try_expression";
  const call = tried ? namedChildren(value)[0] : value;
  const callee = call?.type === "call_expression" ? call.childForFieldName("function") : null;
  const name = callee?.type === "scoped_identifier" ? callee.childForFieldName("name")?.text : undefined;
  return name ? (tried ? "?" : "") + name : null;
}

function walkRust(node: Node, facts: FileFacts, scope: RustScope, impls: [string, string][]): void {
  const here = { line: line(node), endLine: endLine(node), column: column(node) };
  let inner = scope;
  switch (node.type) {
    case "mod_item": {
      const name = node.childForFieldName("name")?.text;
      // `mod x;` brings the file `x.rs` in, and makes `x` a name that paths in this file can start with.
      if (name && !node.childForFieldName("body")) facts.imports.push({ specifier: `self::${name}`, names: [{ local: name, imported: name }], reexport: false, star: false, line: line(node) });
      else {
        if (name) facts.exports.push({ exported: name, local: name });
        inner = { ...scope, inline: scope.inline + 1 };
      }
      break;
    }
    case "const_item":
    case "static_item":
    case "macro_definition": {
      // Not symbols, but names a `use` can lead to.
      const name = node.childForFieldName("name")?.text;
      if (name && !scope.inFunction) facts.exports.push({ exported: name, local: name });
      break;
    }
    case "use_declaration": {
      const argument = node.childForFieldName("argument");
      const reexport = namedChildren(node).some((child) => child.type === "visibility_modifier");
      for (const use of argument ? rustUses(argument, []) : []) {
        if (use.path.length === 0 || (!use.star && !use.local)) continue;
        const last = use.path[use.path.length - 1] ?? "";
        facts.imports.push({ specifier: rustFromFile(use.path, scope.inline).join("::"), names: use.star || !use.local ? [] : [{ local: use.local, imported: last }], reexport, star: use.star, line: line(node) });
      }
      return;
    }
    case "struct_item":
    case "enum_item":
    case "union_item":
    case "trait_item":
    case "type_item": {
      const name = node.childForFieldName("name")?.text;
      if (!name || scope.inFunction) break;
      const symbol: SymbolFact = { name, kind: "class", line: line(node), endLine: endLine(node), exported: namedChildren(node).some((child) => child.type === "visibility_modifier"), isDefault: false };
      const body = node.childForFieldName("body");
      for (const field of body?.type === "field_declaration_list" ? namedChildren(body) : []) {
        const fieldName = field.childForFieldName("name")?.text;
        const fieldType = rustTypeName(field.childForFieldName("type"), scope.bounds);
        if (fieldName && fieldType) (symbol.fields ??= {})[fieldName] = fieldType;
      }
      addSymbol(facts, symbol);
      if (node.type === "trait_item") inner = { ...scope, owner: name };
      break;
    }
    case "impl_item": {
      const type = rustTypeName(node.childForFieldName("type"), new Map());
      const trait = rustTypeName(node.childForFieldName("trait"), new Map());
      if (type && trait) impls.push([type.split("::").pop() ?? type, trait]);
      inner = { ...scope, owner: type ? (type.split("::").pop() ?? type) : null };
      break;
    }
    case "function_item":
    case "function_signature_item":
    case "closure_expression": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.owner && !scope.inFunction) {
        const method: SymbolFact = { name: `${scope.owner}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: false, isDefault: false };
        const returned = node.childForFieldName("return_type");
        // `Result<Self>`, `io::Result<Self>`, `Option<Self>` and aliases such as `CompileResult<'a, Self>` wrap what `?` takes out.
        const wrapped = returned?.type === "generic_type" && /(?:Result|Option)$/.test(returned.childForFieldName("type")?.text ?? "");
        const argumentList = wrapped ? returned.childForFieldName("type_arguments") : null;
        const inner = argumentList ? namedChildren(argumentList).find((argument) => argument.type !== "lifetime") : returned;
        const plain = rustTypeName(inner, new Map())?.split("::").pop();
        if (returned) method.returns = (wrapped ? "?" : "") + (plain === "Self" ? scope.owner : (plain ?? "?"));
        addSymbol(facts, method);
      } else if (name && !scope.inFunction) {
        addSymbol(facts, { name, kind: "function", line: line(node), endLine: endLine(node), exported: namedChildren(node).some((child) => child.type === "visibility_modifier"), isDefault: false });
      } else if (name) {
        facts.locals.push({ name, kind: "other", line: line(node), endLine: scope.scopeEnd, column: column(node) });
      }
      const bounds = new Map(scope.bounds);
      const typeParameters = node.childForFieldName("type_parameters");
      for (const parameter of typeParameters ? namedChildren(typeParameters) : []) {
        const bound = parameter.childForFieldName("bounds");
        const trait = rustTypeName(bound ? namedChildren(bound)[0] : null, scope.bounds);
        const parameterName = parameter.childForFieldName("name")?.text;
        if (parameterName && trait) bounds.set(parameterName, trait);
      }
      const parameters = node.childForFieldName("parameters");
      for (const parameter of parameters ? namedChildren(parameters) : []) {
        if (parameter.type === "self_parameter") {
          if (scope.owner) facts.locals.push({ name: "self", kind: "instance", type: scope.owner, ...here });
        } else if (parameter.type === "parameter") {
          const pattern = parameter.childForFieldName("pattern");
          const type = pattern?.type === "identifier" ? rustTypeName(parameter.childForFieldName("type"), bounds) : null;
          if (pattern?.type === "identifier" && type) facts.locals.push({ name: pattern.text, kind: "instance", type, ...here });
          else rustOthers(pattern, here, facts);
        } else rustOthers(parameter, here, facts);
      }
      inner = { ...scope, inFunction: true, scopeEnd: endLine(node), bounds };
      break;
    }
    case "let_declaration": {
      const pattern = node.childForFieldName("pattern");
      const range = { ...here, endLine: scope.scopeEnd };
      const type = pattern?.type === "identifier" ? rustLetType(node, scope.bounds) : null;
      const via = type ? rustLetConstructor(node) : null;
      if (pattern?.type === "identifier" && type) facts.locals.push({ name: pattern.text, kind: "instance", type, ...(via ? { via } : {}), ...range });
      else rustOthers(pattern, range, facts);
      break;
    }
    case "for_expression":
    case "match_arm":
      rustOthers(node.childForFieldName("pattern"), here, facts);
      break;
    case "let_condition":
      // `if let Some(x) = ...` and `while let`: the names live as long as the statement they are the condition of.
      rustOthers(node.childForFieldName("pattern"), { ...here, endLine: endLine(node.parent ?? node) }, facts);
      break;
    case "call_expression": {
      let callee = node.childForFieldName("function");
      if (callee?.type === "generic_function") callee = callee.childForFieldName("function");
      const at = { line: line(node), column: column(node) };
      if (callee?.type === "identifier") facts.calls.push({ callee: callee.text, receiver: null, ...at });
      else if (callee?.type === "scoped_identifier") {
        const name = callee.childForFieldName("name")?.text;
        const path = callee.childForFieldName("path")?.text.replace(/\s+/g, "");
        // A path call keeps its path as the receiver, marked by the trailing `::` so that it is not taken for a variable.
        if (name && path) facts.calls.push({ callee: name, receiver: `${rustFromFile(path.split("::"), scope.inline).join("::")}::`, ...at });
      } else if (callee?.type === "field_expression") {
        const value = callee.childForFieldName("value");
        const field = callee.childForFieldName("field")?.text;
        if (!field) break;
        if (value?.type === "identifier" || value?.type === "self") facts.calls.push({ callee: field, receiver: value.text, ...at });
        else if (value?.type === "field_expression" && value.childForFieldName("value")?.type === "self") {
          const owner = value.childForFieldName("field")?.text;
          if (owner) facts.calls.push({ callee: field, receiver: `self.${owner}`, ...at });
        }
      }
      break;
    }
    case "token_tree": {
      // Inside a macro there is no syntax tree, only tokens: `assert_eq!(total(x), 3)` still calls `total`.
      const tokens = namedChildren(node);
      tokens.forEach((token, index) => {
        const next = tokens[index + 1];
        if (token.type !== "identifier" || next?.type !== "token_tree" || !next.text.startsWith("(") || next.startIndex !== token.endIndex) return;
        // `x.len()` is a method call on something unknown. `a::b::total()` is a path call: collect the path backwards.
        const path: string[] = [];
        let before = token.previousSibling;
        while (before?.type === "::" && before.previousSibling && /^(?:identifier|crate|super|self)$/.test(before.previousSibling.type)) {
          path.unshift(before.previousSibling.text);
          before = before.previousSibling.previousSibling;
        }
        if (before?.type === "." || before?.type === "::" || before?.type === "$") return;
        const receiver = path.length > 0 ? `${rustFromFile(path, scope.inline).join("::")}::` : null;
        facts.calls.push({ callee: token.text, receiver, line: line(token), column: column(token) });
      });
      break;
    }
    case "string_literal":
    case "raw_string_literal":
      sniffSql(node, facts);
      return;
    default:
      break;
  }
  if (node.type === "block" || node.type === "match_arm") inner = { ...inner, scopeEnd: endLine(node) };
  for (const child of namedChildren(node)) walkRust(child, facts, inner, impls);
}

export function extractRust(root: Node, facts: FileFacts): void {
  const impls: [string, string][] = [];
  walkRust(root, facts, { owner: null, inFunction: false, scopeEnd: endLine(root), bounds: new Map(), inline: 0 }, impls);
  // `impl Trait for Type` gives the type the trait's methods, default ones included.
  for (const [type, trait] of impls) {
    const symbol = facts.symbols.find((candidate) => candidate.name === type && candidate.kind === "class");
    if (symbol && !symbol.embeds?.includes(trait)) (symbol.embeds ??= []).push(trait);
  }
}
