import type { Node } from "web-tree-sitter";
import type { CallRef, FileFacts, ImportFact, ImportedName, SymbolFact } from "./facts.js";
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

/**
 * The first type a function returns: `T` in `T`, `*T`, `(T, error)`. A name that is one of the
 * function's own type parameters, or one the receiver is written with (`func (c *Cache[Key]) Get() Key`),
 * is not a type of the package.
 */
function goReturns(declaration: Node): string | null {
  const result = declaration.childForFieldName("result");
  const returned = result?.type === "parameter_list" ? goTypeName(namedChildren(result)[0]?.childForFieldName("type")) : goTypeName(result);
  if (!returned) return null;
  const receiver = declaration.childForFieldName("receiver");
  const parameters = [...(declaration.childForFieldName("type_parameters")?.descendantsOfType("type_parameter_declaration") ?? []), ...(receiver?.descendantsOfType("type_arguments") ?? [])];
  const names = parameters.flatMap((parameter) => (parameter ? parameter.descendantsOfType(["identifier", "type_identifier"]) : [])).map((name) => name?.text);
  return names.includes(returned) ? null : returned;
}

/** A call written simply enough to say what is called: `f()`, `x.f()`, `x.y.f()`, and any of those on the result of another such call. */
function goCallRef(node: Node | null | undefined, depth = 0): CallRef | null {
  if (node?.type !== "call_expression" || depth > 8) return null;
  const callee = node.childForFieldName("function");
  const at = { line: line(node), column: column(node) };
  if (callee?.type === "identifier") return { callee: callee.text, receiver: null, ...at };
  if (callee?.type !== "selector_expression") return null;
  const operand = callee.childForFieldName("operand");
  const field = callee.childForFieldName("field");
  if (!field || !operand) return null;
  if (operand.type === "identifier" || (operand.type === "selector_expression" && operand.childForFieldName("operand")?.type === "identifier")) {
    return { callee: field.text, receiver: operand.text, ...at };
  }
  const via = goCallRef(operand, depth + 1);
  return via ? { callee: field.text, receiver: "()", ...at, via } : null;
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
    // The name means this from the end of the declaration on: in `view := view.New()` the right side still reads the package.
    const range = { line: endLine(at), endLine: Math.max(endLine(at), inHeader ? endLine(holder) : scope.scopeEnd), column: at.endPosition.column };
    const value = values.length === names.length ? values[index] : index === 0 && values.length === 1 ? values[0] : undefined;
    const known = type ?? (values.length === names.length ? goConstructedType(value) : null);
    // `x := New()`, `x, err := Open()`: what the name holds is the first thing the call returns.
    const from = known ? null : goCallRef(value);
    if (known) facts.locals.push({ name: name.text, kind: "instance", type: known, ...range });
    else if (from) facts.locals.push({ name: name.text, kind: "instance", from, ...range });
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
      const returns = goReturns(node);
      if (name) addSymbol(facts, { name, kind: "function", line: line(node), endLine: endLine(node), exported: /^[A-Z]/.test(name), isDefault: false, ...(returns ? { returns } : {}) });
      goParameters(node.childForFieldName("parameters"), node, facts);
      goParameters(node.childForFieldName("result"), node, facts);
      break;
    }
    case "method_declaration": {
      const name = node.childForFieldName("name")?.text;
      const receiver = node.childForFieldName("receiver");
      const owner = goTypeName(receiver ? namedChildren(receiver)[0]?.childForFieldName("type") : null);
      const returns = goReturns(node);
      if (name && owner) addSymbol(facts, { name: `${owner}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: /^[A-Z]/.test(name), isDefault: false, ...(returns ? { returns } : {}) });
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
    case "type_switch_statement": {
      // `switch x := v.(type)`: in each case `x` is something else, which is not followed.
      for (const name of namedChildren(node.childForFieldName("alias") ?? node).filter((child) => child.type === "identifier")) {
        facts.locals.push({ name: name.text, kind: "other", line: line(node), endLine: endLine(node), column: column(node) });
      }
      break;
    }
    case "receive_statement": {
      // `case x := <-ch:` declares `x` for that case of the `select`.
      const left = node.childForFieldName("left");
      const holder = node.parent?.type === "communication_case" ? node.parent : node;
      if (left && /^\s*:=/.test(node.text.slice(left.text.length))) {
        for (const name of namedChildren(left)) if (name.type === "identifier" && name.text !== "_") facts.locals.push({ name: name.text, kind: "other", line: line(holder), endLine: endLine(holder), column: column(holder) });
      }
      break;
    }
    case "range_clause": {
      const left = node.childForFieldName("left");
      goDeclared(left ? namedChildren(left) : [], null, [], node, scope, facts);
      break;
    }
    case "call_expression": {
      const call = goCallRef(node);
      if (call) facts.calls.push(call);
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
  /** The type parameters of the classes around (`Item` in `class Box<Item>`): names that are not classes. */
  generics?: Set<string>;
  /** The class the one being walked extends, as written: what `super(...)` in a constructor builds. */
  parent?: string | null;
}

/** The names a `<..>` list on a class or a method declares. */
function javaGenerics(node: Node, into: Set<string>): Set<string> {
  const list = node.childForFieldName("type_parameters");
  for (const parameter of list ? namedChildren(list) : []) {
    const name = namedChildren(parameter).find((child) => child.type === "type_identifier" || child.type === "identifier");
    if (name) into.add(name.text);
  }
  return into;
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

/**
 * A call written simply enough to say what is called: `f()`, `x.f()`, `this.f()`, `this.field.f()`,
 * `new T()`, and a method on the result of another such call (`a.open().read()`, `new T().run()`).
 */
function javaCallRef(node: Node | null | undefined, scope: JavaScope, depth = 0): CallRef | null {
  while (node?.type === "parenthesized_expression") node = namedChildren(node)[0];
  if (!node || depth > 8) return null;
  const at = { line: line(node), column: column(node) };
  if (node.type === "object_creation_expression") {
    const type = javaTypeName(node.childForFieldName("type"));
    return type ? { callee: type, receiver: "new", ...at } : null;
  }
  if (node.type !== "method_invocation") return null;
  const name = node.childForFieldName("name")?.text;
  const object = node.childForFieldName("object");
  if (!name) return null;
  // Inside an anonymous class, a call with no receiver belongs to a class this file may not show.
  if ((!object || object.type === "this" || object.type === "super") && scope.anonymous) return null;
  if (!object) return { callee: name, receiver: null, ...at };
  if (object.type === "identifier" || object.type === "this" || object.type === "super") return { callee: name, receiver: object.text, ...at };
  if (object.type === "field_access" && object.childForFieldName("object")?.type === "this") {
    const field = object.childForFieldName("field");
    return field ? { callee: name, receiver: `this.${field.text}`, ...at } : null;
  }
  const via = javaCallRef(object, scope, depth + 1);
  return via ? { callee: name, receiver: "()", ...at, via } : null;
}

/**
 * A name with a class written as its type: an instance of it between `line` and `endLine`. `var`
 * takes the type from `new T()`, or from what the method called returns.
 */
function javaDeclared(name: Node | null, type: Node | null, value: Node | null, range: { line: number; endLine: number; column: number }, facts: FileFacts, scope?: JavaScope): void {
  if (name?.type !== "identifier") return;
  const inferred = type?.text === "var";
  const written = inferred ? (value?.type === "object_creation_expression" ? javaTypeName(value.childForFieldName("type")) : null) : javaTypeName(type);
  const from = inferred && !written && scope ? javaCallRef(value, scope) : null;
  if (written) facts.locals.push({ name: name.text, kind: "instance", type: written, ...range });
  else if (from) facts.locals.push({ name: name.text, kind: "instance", from, ...range });
  else facts.locals.push({ name: name.text, kind: "other", ...range });
}

/**
 * Notes a class name the file mentions. With `maybe`, the name stands where a variable could
 * stand too (`MAX.length`, `Limits.MAX`): it counts as a class only if nothing of that name is
 * declared there, which the linker checks. A mention as a type settles it.
 */
function javaUse(name: string, node: Node, facts: FileFacts, maybe = false): void {
  if (/^[A-Z]$/.test(name)) return;
  const uses = (facts.uses ??= []);
  const seen = uses.find((use) => use.name === name);
  if (!seen) uses.push({ name, line: line(node), ...(maybe ? { maybe } : {}) });
  else if (!maybe) delete seen.maybe;
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

      const inside: JavaScope = { owner: qualified, ownerRange: [line(node), endLine(node)], scopeEnd: endLine(node), generics: javaGenerics(node, new Set(scope.generics)), parent: symbol.extends ?? null };
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
        // What the method returns, unless that is a type parameter of the method or of a class around it.
        const written = javaTypeName(node.childForFieldName("type"));
        const returns = written && !javaGenerics(node, new Set(scope.generics)).has(written) ? written : "?";
        const overload = facts.symbols.find((symbol) => symbol.name === `${scope.owner}.${name}`);
        // Overloads are one symbol: when they return different things, nothing can be said for a call of the name.
        if (overload && overload.returns !== returns) overload.returns = "?";
        // The parameter types tell an override of an inherited method (same list) from an overload of it (another list).
        const parameterList = node.childForFieldName("parameters");
        const params = (parameterList ? namedChildren(parameterList) : []).map((parameter) => parameter.childForFieldName("type")?.text.replace(/\s+/g, "") ?? "?").join(",");
        addSymbol(facts, { name: `${scope.owner}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: false, isDefault: false, returns, params });
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
        javaDeclared(declarator.childForFieldName("name"), node.childForFieldName("type"), declarator.childForFieldName("value"), { ...here, endLine: scope.scopeEnd }, facts, scope);
      }
      break;
    case "enhanced_for_statement":
    case "resource":
      javaDeclared(node.childForFieldName("name"), node.childForFieldName("type"), node.type === "resource" ? node.childForFieldName("value") : null, node.type === "resource" ? { ...here, endLine: scope.scopeEnd } : here, facts, scope);
      break;
    case "catch_clause": {
      const parameter = namedChildren(node).find((child) => child.type === "catch_formal_parameter");
      const type = parameter ? namedChildren(parameter).find((child) => child.type === "catch_type") : undefined;
      javaDeclared(parameter?.childForFieldName("name") ?? null, type ? (namedChildren(type)[0] ?? null) : null, null, here, facts);
      break;
    }
    case "method_invocation": {
      const call = javaCallRef(node, scope);
      if (call) facts.calls.push(call);
      // `Labels.format()`: a capitalised receiver may be a class that is used without being imported.
      const object = node.childForFieldName("object");
      if (object?.type === "identifier" && /^[A-Z]/.test(object.text)) javaUse(object.text, object, facts, true);
      break;
    }
    case "object_creation_expression": {
      const call = javaCallRef(node, scope);
      if (call) facts.calls.push(call);
      break;
    }
    case "explicit_constructor_invocation":
      // `super(...)` in a constructor runs the parent's constructor: a use of the parent class, as `new Parent(...)` is.
      if (node.childForFieldName("constructor")?.type === "super" && scope.parent && !scope.anonymous) {
        // The parent is named outside the class body, where the classes declared in the body are not in view: `extends`.
        facts.calls.push({ callee: scope.parent, receiver: "extends", line: line(node), column: column(node) });
      }
      break;
    case "field_access": {
      // `Limits.MAX`, `Outer.Inner.MAX`: a capitalised name at the start may be a class of the package, used without an import.
      const object = node.childForFieldName("object");
      if (object?.type === "identifier" && /^[A-Z]/.test(object.text)) javaUse(object.text, object, facts, true);
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
  // A class declared inside a generic method sees the method's type parameters.
  if (node.type === "method_declaration" && node.childForFieldName("type_parameters")) inner = { ...inner, generics: javaGenerics(node, new Set(scope.generics)) };
  // The body of `new Foo() { ... }` is a class of its own with no name: its fields are its own, its
  // methods are not symbols, and what an unqualified call in it means depends on `Foo`, which may not be in this file.
  if (node.type === "class_body" && node.parent?.type === "object_creation_expression") {
    inner = { owner: null, ownerRange: [line(node), endLine(node)], scopeEnd: endLine(node), anonymous: true, generics: scope.generics };
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
  /** The type parameters of the `impl` or trait around: names that are not types of the crate. */
  generics: Set<string>;
  /** Inside a trait: `Self` is whatever type implements it, which the trait does not say. */
  inTrait: boolean;
}

/** The names a `<..>` list declares: `Key` and `V` in `<'a, Key: Hash, V>`. */
function rustGenerics(node: Node, into: Set<string>): Set<string> {
  const list = node.childForFieldName("type_parameters");
  for (const parameter of list ? namedChildren(list) : []) {
    const name = parameter.type === "type_identifier" ? parameter.text : parameter.childForFieldName("name")?.text;
    if (name) into.add(name);
  }
  return into;
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

/**
 * What a Rust function returns, as written (`T`, `a::T`), or `?T` when wrapped in `Result` or `Option`;
 * `?` for anything that does not name one type of the crate: a type parameter, an associated type
 * (`Self::Item`), `Self` in a trait, a tuple, a `Vec`.
 */
function rustReturns(node: Node, scope: RustScope): string | null {
  const returned = node.childForFieldName("return_type");
  if (!returned) return null;
  // `Result<Self>`, `io::Result<Self>`, `Option<Self>` and aliases such as `CompileResult<'a, Self>` wrap what `?` takes out.
  const wrapped = returned.type === "generic_type" && /(?:Result|Option)$/.test(returned.childForFieldName("type")?.text ?? "");
  const argumentList = wrapped ? returned.childForFieldName("type_arguments") : null;
  const inner = argumentList ? namedChildren(argumentList).find((argument) => argument.type !== "lifetime") : returned;
  const written = rustTypeName(inner, new Map())?.replace(/\s+/g, "");
  const generics = rustGenerics(node, new Set(scope.generics));
  const plain = !written || generics.has(written) || /^Self::/.test(written) ? null : written === "Self" ? (scope.inTrait ? null : scope.owner) : written;
  return (wrapped ? "?" : "") + (plain ?? "?");
}

/** The call under `?`, `.await`, `.unwrap()` and `.expect(..)`, and whether one of them took the value out of a `Result` or an `Option`. */
function rustUnwrapped(value: Node | null | undefined): { call: Node | null; tried: boolean } {
  let tried = false;
  for (let at = value; at; ) {
    if (at.type === "try_expression") {
      tried = true;
      at = namedChildren(at)[0];
    } else if (at.type === "await_expression" || at.type === "parenthesized_expression") {
      at = namedChildren(at)[0];
    } else if (at.type === "call_expression") {
      const callee = at.childForFieldName("function");
      const unwraps = callee?.type === "field_expression" && /^(?:unwrap|expect)$/.test(callee.childForFieldName("field")?.text ?? "");
      if (!unwraps) return { call: at, tried };
      tried = true;
      at = callee?.childForFieldName("value") ?? undefined;
    } else {
      return { call: null, tried };
    }
  }
  return { call: null, tried };
}

/** A call written simply enough to say what is called: `f()`, `a::b::f()`, `x.f()`, `self.y.f()`, and a method on the result of another such call. */
function rustCallRef(node: Node | null | undefined, inline: number, depth = 0): CallRef | null {
  if (node?.type !== "call_expression" || depth > 8) return null;
  let callee = node.childForFieldName("function");
  if (callee?.type === "generic_function") callee = callee.childForFieldName("function");
  const at = { line: line(node), column: column(node) };
  if (callee?.type === "identifier") return { callee: callee.text, receiver: null, ...at };
  if (callee?.type === "scoped_identifier") {
    const name = callee.childForFieldName("name")?.text;
    const path = callee.childForFieldName("path")?.text.replace(/\s+/g, "");
    // A path call keeps its path as the receiver, marked by the trailing `::` so that it is not taken for a variable.
    return name && path ? { callee: name, receiver: `${rustFromFile(path.split("::"), inline).join("::")}::`, ...at } : null;
  }
  if (callee?.type !== "field_expression") return null;
  const value = callee.childForFieldName("value");
  const field = callee.childForFieldName("field")?.text;
  if (!field || !value) return null;
  if (value.type === "identifier" || value.type === "self") return { callee: field, receiver: value.text, ...at };
  if (value.type === "field_expression" && value.childForFieldName("value")?.type === "self") {
    const owner = value.childForFieldName("field")?.text;
    return owner ? { callee: field, receiver: `self.${owner}`, ...at } : null;
  }
  const { call, tried } = rustUnwrapped(value);
  const via = rustCallRef(call, inline, depth + 1);
  return via ? { callee: field, receiver: "()", ...at, via: { ...via, ...(tried ? { tried } : {}) } } : null;
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
      if (node.type === "trait_item") inner = { ...scope, owner: name, generics: rustGenerics(node, new Set()), inTrait: true };
      break;
    }
    case "impl_item": {
      const type = rustTypeName(node.childForFieldName("type"), new Map());
      const trait = rustTypeName(node.childForFieldName("trait"), new Map());
      if (type && trait) impls.push([type.split("::").pop() ?? type, trait]);
      inner = { ...scope, owner: type ? (type.split("::").pop() ?? type) : null, generics: rustGenerics(node, new Set()), inTrait: false };
      break;
    }
    case "function_item":
    case "function_signature_item":
    case "closure_expression": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.owner && !scope.inFunction) {
        const method: SymbolFact = { name: `${scope.owner}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: false, isDefault: false };
        const returns = rustReturns(node, scope);
        if (returns) method.returns = returns;
        addSymbol(facts, method);
      } else if (name && !scope.inFunction) {
        const returns = rustReturns(node, { ...scope, owner: null });
        addSymbol(facts, { name, kind: "function", line: line(node), endLine: endLine(node), exported: namedChildren(node).some((child) => child.type === "visibility_modifier"), isDefault: false, ...(returns ? { returns } : {}) });
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
      // The name means this from the end of the statement on: `let x = x.next()` still reads the old `x`.
      const range = { line: endLine(node), endLine: Math.max(endLine(node), scope.scopeEnd), column: node.endPosition.column };
      const type = pattern?.type === "identifier" ? rustLetType(node, scope.bounds) : null;
      const via = type ? rustLetConstructor(node) : null;
      // `let x = open(..)?`, `let x = a.b()`: no type is written, but the function called may say what it returns.
      // The same holds for `let x = T::name()` when `name` turns out not to return a `T`.
      const made = pattern?.type === "identifier" && (!type || via) && !node.childForFieldName("type") ? rustUnwrapped(node.childForFieldName("value")) : null;
      const call = made ? rustCallRef(made.call, scope.inline) : null;
      const from = call ? { from: { ...call, ...(made?.tried ? { tried: true } : {}) } } : {};
      if (pattern?.type === "identifier" && type) facts.locals.push({ name: pattern.text, kind: "instance", type, ...(via ? { via } : {}), ...from, ...range });
      else if (pattern?.type === "identifier" && call) facts.locals.push({ name: pattern.text, kind: "instance", ...from, ...range });
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
      const call = rustCallRef(node, scope.inline);
      if (call) facts.calls.push(call);
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
  walkRust(root, facts, { owner: null, inFunction: false, scopeEnd: endLine(root), bounds: new Map(), inline: 0, generics: new Set(), inTrait: false }, impls);
  // `impl Trait for Type` gives the type the trait's methods, default ones included.
  for (const [type, trait] of impls) {
    const symbol = facts.symbols.find((candidate) => candidate.name === type && candidate.kind === "class");
    if (symbol && !symbol.embeds?.includes(trait)) (symbol.embeds ??= []).push(trait);
  }
}

// ---------- Ruby ----------

interface RubyScope {
  /** Full names of the classes and modules around, innermost first: where a constant is looked up. */
  nesting: string[];
  /** The class or module a `def` here is a method of. Null at the top of a file. */
  owner: string | null;
  inDef: boolean;
  inBlock: boolean;
  /** The method around, which is what `super` calls in the parent. */
  method: string | null;
  /** Names that are local variables somewhere in the method (or body) around. A bare name outside this set is a call. */
  variables: Set<string>;
  /** The variables that are given `Type.new` somewhere, so that another assignment has to be noted as hiding it. */
  typed: Set<string>;
  /** `attr_reader` names of the class around: `repo.find` is then `@repo.find`. */
  attrs: Set<string>;
  /** Last line of the innermost method or block. */
  scopeEnd: number;
  /** Last line of the method (or body) around: how far a name that stops being a known instance stays unknown. */
  bodyEnd: number;
  /** Instance variables the classes around hold a known instance in. A class inside does not share them. */
  fields: Set<string>;
  /** The constants already noted, by namespace. One set for the whole file. */
  seen: Set<string>;
}

const RUBY_OWN_SCOPE = new Set(["method", "singleton_method", "class", "module", "singleton_class"]);
const RUBY_REQUIRES = new Set(["require", "require_relative", "autoload"]);
const RUBY_MIXINS = new Set(["include", "extend", "prepend"]);
const RUBY_RECORD_BASES = new Set(["ApplicationRecord", "ActiveRecord::Base"]);
const RUBY_CLASS_MAKERS = new Set(["Struct.new", "Class.new", "Data.define"]);

/** `A::B` from a constant or a chain of them, `::A` when it is written from the top. Null for anything looked up at run time (`self::A`, `x::A`). */
function rubyConstant(node: Node | null | undefined): string | null {
  if (node?.type === "constant") return node.text;
  if (node?.type !== "scope_resolution") return null;
  const name = node.childForFieldName("name");
  if (name?.type !== "constant") return null;
  const scope = node.childForFieldName("scope");
  if (!scope) return `::${name.text}`;
  const outer = rubyConstant(scope);
  return outer ? `${outer}::${name.text}` : null;
}

/** `T` from `T.new(...)`. */
function rubyNewType(value: Node | null | undefined): string | null {
  if (value?.type !== "call" || value.childForFieldName("method")?.text !== "new") return null;
  return rubyConstant(value.childForFieldName("receiver"));
}

function rubyUse(node: Node, facts: FileFacts, scope: RubyScope, outside = false): void {
  const name = rubyConstant(node);
  if (!name) return;
  // The same name can mean two things in two namespaces of one file, so it is kept once for each.
  const key = `${scope.nesting[0] ?? ""}\u0000${name}`;
  if (scope.seen.has(key)) return;
  scope.seen.add(key);
  (facts.uses ??= []).push({ name, line: line(node), ...(outside ? { outside: true } : {}) });
}

/** The names a parameter list binds. Default values are not names. */
function rubyParameterNames(parameters: Node | null | undefined, into: Set<string>): void {
  for (const parameter of parameters ? namedChildren(parameters) : []) {
    if (parameter.type === "identifier") into.add(parameter.text);
    else if (parameter.type === "destructured_parameter") rubyParameterNames(parameter, into);
    else {
      const name = parameter.childForFieldName("name");
      if (name) into.add(name.text);
    }
  }
}

function rubyAssigned(left: Node | null | undefined, into: Set<string>): void {
  if (left?.type === "identifier") into.add(left.text);
  else if (left && (left.type === "left_assignment_list" || left.type === "destructured_left_assignment" || left.type === "rest_assignment")) {
    for (const child of namedChildren(left)) rubyAssigned(child, into);
  }
}

const RUBY_PATTERNS = new Set(["in_clause", "test_pattern", "match_pattern"]);

/** The names a pattern binds: `in {name:, port: Integer => port}`, `in [first, *rest]`. */
function rubyPatternNames(pattern: Node, into: Set<string>): void {
  if (pattern.type === "identifier") into.add(pattern.text);
  else if (pattern.type === "keyword_pattern" && !pattern.childForFieldName("value")) into.add(pattern.childForFieldName("key")?.text ?? "");
  for (const child of namedChildren(pattern)) rubyPatternNames(child, into);
}

/** The local variables of one method or body: its parameters and everything assigned in it, blocks included. What a block takes as parameters is known only inside the block. */
function rubyVariables(node: Node, variables: Set<string>, typed: Set<string>): void {
  for (const child of namedChildren(node)) {
    if (RUBY_OWN_SCOPE.has(child.type)) continue;
    if (child.type === "assignment" || child.type === "operator_assignment") {
      const left = child.childForFieldName("left");
      rubyAssigned(left, variables);
      if (left?.type === "identifier" && rubyNewType(child.childForFieldName("right"))) typed.add(left.text);
    } else if (child.type === "method_parameters") rubyParameterNames(child, variables);
    else if (child.type === "exception_variable") rubyAssigned(namedChildren(child)[0], variables);
    else if (child.type === "for") rubyAssigned(child.childForFieldName("pattern"), variables);
    else if (RUBY_PATTERNS.has(child.type)) {
      const pattern = child.childForFieldName("pattern");
      if (pattern) rubyPatternNames(pattern, variables);
    }
    rubyVariables(child, variables, typed);
  }
}

/** What a class body says about its instance variables and readers, in any of its methods. Nested classes speak for themselves. */
/**
 * Whether giving `name` this value leaves it open what the name holds, so that its spelling may
 * still say it: nothing or `nil`, a value passed on under the same name (`@account = account`,
 * `account = target_account`, `account = status.account`), or something made by the class of that name
 * (`account = Account.find(id)`).
 * Any other value (`{}`, `params[:id]`, `User.find(id)`, `site.config["url"]`) is something else.
 */
function rubyKeepsName(name: string, value: Node | null | undefined): boolean {
  if (!value || value.type === "nil") return true;
  const own = name.replace(/^@/, "");
  const sameWord = (other: string) => other === own || other.endsWith(`_${own}`) || own.endsWith(`_${other}`);
  if (value.type === "identifier" || value.type === "instance_variable") return sameWord(value.text.replace(/^@/, ""));
  if (value.type !== "call") return false;
  const receiver = value.childForFieldName("receiver");
  const maker = rubyConstant(receiver);
  if (maker) return sameWord(rubyUnderscore(maker.split("::").pop() ?? maker));
  // `account = status.account`, `@regenerator = site.regenerator`: read off something under the same name.
  const method = value.childForFieldName("method");
  return method?.type === "identifier" && sameWord(method.text);
}

function rubyClassState(node: Node, ivars: Map<string, Set<string>>, attrs: Set<string>): void {
  for (const child of namedChildren(node)) {
    if (child.type === "class" || child.type === "module") continue;
    if (child.type === "assignment" || child.type === "operator_assignment") {
      const left = child.childForFieldName("left");
      const right = child.childForFieldName("right");
      const note = (name: string, type: string) => {
        const types = ivars.get(name) ?? new Set<string>();
        ivars.set(name, types);
        types.add(type);
      };
      if (left?.type === "instance_variable" && right?.type !== "nil") note(left.text, rubyNewType(right) ?? (rubyKeepsName(left.text, right) ? "?" : "="));
      // `@a, @b = pair`: each gets something that cannot be told.
      else if (left?.type === "left_assignment_list") for (const target of left.descendantsOfType("instance_variable")) if (target) note(target.text, "=");
    } else if (child.type === "call" && !child.childForFieldName("receiver") && /^attr_(?:reader|accessor)$/.test(child.childForFieldName("method")?.text ?? "")) {
      for (const argument of namedChildren(child.childForFieldName("arguments") ?? child)) if (argument.type === "simple_symbol") attrs.add(argument.text.slice(1));
    }
    rubyClassState(child, ivars, attrs);
  }
}

/** `include M`, `extend M`, `prepend M` written directly in a class body. */
function rubyMixins(body: Node | null): string[] {
  const mixins: string[] = [];
  for (const child of body ? namedChildren(body) : []) {
    if (child.type !== "call" || child.childForFieldName("receiver") || !RUBY_MIXINS.has(child.childForFieldName("method")?.text ?? "")) continue;
    for (const argument of namedChildren(child.childForFieldName("arguments") ?? child)) {
      const name = rubyConstant(argument);
      if (name) mixins.push(name);
    }
  }
  return mixins;
}

const RUBY_UNCOUNTABLE = /(?:equipment|information|rice|money|species|series|fish|sheep|police|news|metadata)$/;
const RUBY_PLURALS: [RegExp, string][] = [
  [/(?<=^|_)person$/, "people"],
  [/man$/, "men"],
  [/child$/, "children"],
  [/(quiz)$/, "$1zes"],
  [/([^aeiouy]|qu)y$/, "$1ies"],
  [/sis$/, "ses"],
  [/(s|x|z|ch|sh)$/, "$1es"],
  [/$/, "s"],
];

/** `OrderItem` → `order_item`, as Ruby names files and tables. */
export const rubyUnderscore = (name: string): string => name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();

/** The table Active Record gives a model by default: `OrderItem` → `order_items`. A guess, to be checked against the tables the repository defines. */
function rubyTableName(className: string): string {
  const singular = rubyUnderscore(className.split("::").pop() ?? className);
  if (RUBY_UNCOUNTABLE.test(singular)) return singular;
  for (const [pattern, replacement] of RUBY_PLURALS) if (pattern.test(singular)) return singular.replace(pattern, replacement);
  return singular;
}

/**
 * Names bound to something that cannot be followed, from `node` on. With `always`, whatever they
 * were: the file says they hold something of its own making. Without it, only names an earlier
 * `x = T.new` made an instance, which they stop being.
 */
function rubyHide(names: Iterable<string>, node: Node, facts: FileFacts, scope: RubyScope, always = false): void {
  for (const name of names) {
    if (always || scope.typed.has(name)) facts.locals.push({ name, kind: "other", line: endLine(node), endLine: scope.bodyEnd, column: node.endPosition.column });
  }
}

/** `def`, `class` and `module` start with no local variables: what the code around them knows about a name does not hold inside. */
function rubyGate(node: Node, facts: FileFacts, scope: RubyScope): void {
  for (const name of scope.typed) facts.locals.push({ name, kind: "other", line: line(node), endLine: endLine(node), column: column(node) });
}

/** A plain string argument: no interpolation. */
function rubyString(node: Node | null | undefined): string | null {
  if (node?.type !== "string") return null;
  const parts = namedChildren(node);
  return parts.every((part) => part.type === "string_content") ? parts.map((part) => part.text).join("") : null;
}

function rubySymbolOrString(node: Node | null | undefined): string | null {
  return node?.type === "simple_symbol" ? node.text.slice(1) : rubyString(node);
}

/** A class or module body: its symbol, its namespace, what its instance variables hold, then its contents. */
function rubyBody(node: Node, body: Node | null, written: string, superclass: string | null, isModule: boolean, facts: FileFacts, scope: RubyScope): void {
  const outer = scope.nesting[0];
  const full = written.startsWith("::") ? written.slice(2) : outer ? `${outer}::${written}` : written;
  const members = body ? namedChildren(body).filter((child) => child.type !== "comment") : [];
  // `module Shop` around other classes, written in every file of the project, is a namespace and not a place.
  const namespaceOnly = isModule && members.length > 0 && members.every((child) => child.type === "class" || child.type === "module" || (child.type === "assignment" && child.childForFieldName("left")?.type === "constant"));
  if (!namespaceOnly) {
    const mixins = rubyMixins(body);
    addSymbol(facts, { name: full, kind: "class", line: line(node), endLine: endLine(node), exported: true, isDefault: false, ...(superclass ? { extends: superclass } : {}), ...(mixins.length > 0 ? { embeds: mixins } : {}), ...(isModule ? { namespace: true } : {}) });
  }
  const nesting = [full, ...scope.nesting];
  (facts.namespaces ??= []).push({ names: nesting, line: line(node), endLine: endLine(node) });
  if (superclass && RUBY_RECORD_BASES.has(superclass.replace(/^::/, "")) && !/\b(?:table_name|abstract_class)\s*=/.test(body?.text ?? "")) {
    // `Web::Setting` is `web_settings` when its module sets a table prefix, which is how Rails generates one, and `settings` when not.
    const plain = rubyTableName(full);
    const prefix = full.includes("::") ? `${full.slice(0, full.lastIndexOf("::")).split("::").map(rubyUnderscore).join("_")}_` : "";
    facts.tables.push({ name: prefix + plain, op: "read", line: line(node), inferred: true, ...(prefix ? { otherwise: plain } : {}) });
  }
  if (!body) return;

  const ivars = new Map<string, Set<string>>();
  const attrs = new Set<string>();
  rubyClassState(body, ivars, attrs);
  const fields = new Set<string>();
  for (const [name, types] of ivars) {
    const [type] = types;
    // `@cache = {}`, `@config = hash` somewhere in the class: whatever else it gets, the name is not to be read as a class.
    if (types.has("=")) facts.locals.push({ name, kind: "other", line: line(node), endLine: endLine(node) });
    if (types.size !== 1 || !type || type === "?" || type === "=") continue;
    fields.add(name);
    facts.locals.push({ name, kind: "instance", type, line: line(node), endLine: endLine(node) });
  }
  // What a class around this one keeps in a variable of the same name is not what this one keeps there.
  for (const name of scope.fields) if (!fields.has(name)) facts.locals.push({ name, kind: "other", line: line(node), endLine: endLine(node) });
  rubyGate(node, facts, scope);
  const variables = new Set<string>();
  const typed = new Set<string>();
  rubyVariables(body, variables, typed);
  const inner: RubyScope = { nesting, owner: full, inDef: false, inBlock: false, method: null, variables, typed, attrs, scopeEnd: endLine(node), bodyEnd: endLine(node), fields: new Set([...scope.fields, ...fields]), seen: scope.seen };
  for (const child of namedChildren(body)) walkRuby(child, facts, inner);
}

/** How the receiver of a call is written down for the linker, or null when nothing can be said about it. */
function rubyReceiver(receiver: Node, scope: RubyScope): string | null {
  switch (receiver.type) {
    case "self":
      return "self";
    case "constant":
    case "scope_resolution":
      return rubyConstant(receiver);
    case "instance_variable":
      return receiver.text;
    case "identifier":
      // A name that is not a variable is a method of the object itself: a reader of a field, or something
      // only its name says anything about (`.name`, kept apart from a variable called `name`).
      return scope.variables.has(receiver.text) ? receiver.text : scope.attrs.has(receiver.text) ? `@${receiver.text}` : `.${receiver.text}`;
    case "call": {
      // `Service.new(order).call`, and `self.class.build` for a method of the class.
      const type = rubyNewType(receiver);
      if (type) return `${type}.new`;
      return receiver.childForFieldName("receiver")?.type === "self" && receiver.childForFieldName("method")?.text === "class" ? "self" : null;
    }
    default:
      return null;
  }
}

function walkRuby(node: Node, facts: FileFacts, scope: RubyScope): void {
  const walkChildren = (parent: Node, inner: RubyScope = scope) => {
    for (const child of namedChildren(parent)) walkRuby(child, facts, inner);
  };
  switch (node.type) {
    case "class":
    case "module": {
      const written = rubyConstant(node.childForFieldName("name"));
      if (!written || scope.inDef) break;
      const parent = node.childForFieldName("superclass");
      const superclass = parent ? rubyConstant(namedChildren(parent)[0]) : null;
      // The parent is named before the class is opened: it is looked up from outside it.
      if (parent && superclass) rubyUse(namedChildren(parent)[0] ?? parent, facts, scope, true);
      else if (parent) walkChildren(parent);
      rubyBody(node, node.childForFieldName("body"), written, superclass, node.type === "module", facts, scope);
      return;
    }
    case "singleton_class":
      // `class << self`: its methods are methods of the class around.
      if (node.childForFieldName("value")?.type !== "self") return;
      walkChildren(node.childForFieldName("body") ?? node);
      return;
    case "method":
    case "singleton_method": {
      const name = node.childForFieldName("name")?.text;
      const object = node.childForFieldName("object");
      if (!name || (object && object.type !== "self" && rubyConstant(object) !== scope.owner?.split("::").pop())) return;
      if (!scope.inDef && scope.owner) {
        addSymbol(facts, { name: `${scope.owner}.${name}`, kind: "method", line: line(node), endLine: endLine(node), exported: false, isDefault: false });
      } else if (!scope.inDef && !scope.inBlock) {
        addSymbol(facts, { name, kind: "function", line: line(node), endLine: endLine(node), exported: !name.startsWith("_"), isDefault: false });
      }
      const variables = new Set<string>();
      const typed = new Set<string>();
      rubyVariables(node, variables, typed);
      rubyGate(node, facts, scope);
      const inner: RubyScope = { ...scope, inDef: true, inBlock: false, method: name, variables, typed, scopeEnd: endLine(node), bodyEnd: endLine(node) };
      for (const child of namedChildren(node)) if (child.id !== node.childForFieldName("name")?.id && child.id !== object?.id) walkRuby(child, facts, inner);
      return;
    }
    case "method_parameters":
    case "block_parameters":
    case "lambda_parameters":
    case "destructured_parameter":
      // Only default values are code. A default says what the parameter usually holds: `config = {}` is not a `Config`.
      for (const parameter of namedChildren(node)) {
        const value = parameter.childForFieldName("value");
        const name = parameter.childForFieldName("name")?.text;
        if (value && name && !rubyKeepsName(name, value)) facts.locals.push({ name, kind: "other", line: line(node), endLine: scope.scopeEnd, column: column(node) });
        if (value) walkRuby(value, facts, scope);
        else if (parameter.type === "destructured_parameter") walkRuby(parameter, facts, scope);
      }
      return;
    case "block":
    case "do_block":
    case "lambda": {
      const taken = new Set<string>();
      rubyParameterNames(node.childForFieldName("parameters"), taken);
      // A parameter named like a variable of the method is another thing for as long as the block lasts.
      for (const name of taken) if (scope.typed.has(name)) facts.locals.push({ name, kind: "other", line: line(node), endLine: endLine(node), column: column(node) });
      walkChildren(node, { ...scope, inBlock: true, scopeEnd: endLine(node), variables: taken.size > 0 ? new Set([...scope.variables, ...taken]) : scope.variables });
      return;
    }
    case "assignment":
    case "operator_assignment": {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.type === "constant" && !scope.inDef && !scope.inBlock) {
        const maker = right?.type === "call" ? `${right.childForFieldName("receiver")?.text ?? ""}.${right.childForFieldName("method")?.text ?? ""}` : "";
        if (right && node.type === "assignment" && RUBY_CLASS_MAKERS.has(maker)) {
          // `Point = Struct.new(:x, :y) do ... end`: a class, with the block as its body.
          const parent = maker === "Class.new" ? rubyConstant(namedChildren(right.childForFieldName("arguments") ?? right)[0]) : null;
          const made = right.childForFieldName("block");
          const body = made ? (made.childForFieldName("body") ?? null) : null;
          const given = right.childForFieldName("arguments");
          if (given) walkRuby(given, facts, scope);
          rubyBody(node, body, left.text, parent, false, facts, scope);
          return;
        }
        const outer = scope.nesting[0];
        facts.exports.push({ exported: outer ? `${outer}::${left.text}` : left.text, local: left.text });
      } else if (left?.type === "identifier") {
        const type = rubyNewType(right);
        // The name means this from the end of the assignment on: `x = x.next` still reads the old one.
        if (type) facts.locals.push({ name: left.text, kind: "instance", type, line: endLine(node), endLine: scope.scopeEnd, column: node.endPosition.column });
        else rubyHide([left.text], node, facts, scope, !rubyKeepsName(left.text, right));
      } else if (left?.type === "left_assignment_list") {
        const names = new Set<string>();
        rubyAssigned(left, names);
        rubyHide(names, node, facts, scope, true);
      } else if (left?.type === "call" && left.childForFieldName("receiver")?.type === "self" && left.childForFieldName("method")?.text === "table_name") {
        const table = rubyString(right);
        // The model says which table it is kept in. The table itself is defined by the schema.
        if (table) facts.tables.push({ name: (table.split(".").pop() ?? table).toLowerCase(), op: "read", line: line(node) });
      } else if (left && left.type !== "instance_variable" && left.type !== "left_assignment_list" && left.type !== "constant") {
        // `a.b = c`, `a[i] = c`: the left side reads names too.
        walkRuby(left, facts, scope);
      }
      if (right) walkRuby(right, facts, scope);
      return;
    }
    case "call": {
      const method = node.childForFieldName("method");
      const receiver = node.childForFieldName("receiver");
      const argumentList = node.childForFieldName("arguments");
      const first = argumentList ? namedChildren(argumentList)[0] : undefined;
      const at = { line: line(node), column: column(node) };
      if (method?.type === "super") {
        if (scope.method) facts.calls.push({ callee: scope.method, receiver: "super", ...at });
      } else if (method && !receiver) {
        if (RUBY_REQUIRES.has(method.text)) {
          const path = rubyString(method.text === "autoload" ? namedChildren(argumentList ?? node)[1] : first);
          // `require "./x"` is relative to where the program was started, which a file does not say.
          const specifier = !path ? null : method.text === "require_relative" ? (path.startsWith(".") ? path : `./${path}`) : path.startsWith(".") ? null : path;
          if (specifier) facts.imports.push({ specifier, names: [], reexport: false, star: false, line: line(node) });
          return;
        }
        if (method.text === "create_table") {
          const table = rubySymbolOrString(first);
          if (table) facts.tables.push({ name: table.toLowerCase(), op: "define", line: line(node) });
        }
        if (method.type === "identifier") facts.calls.push({ callee: method.text, receiver: null, ...at });
      } else if (method && receiver && (method.type === "identifier" || method.type === "constant")) {
        const written = rubyReceiver(receiver, scope);
        if (written) facts.calls.push({ callee: method.text, receiver: written, ...at });
      }
      for (const child of namedChildren(node)) if (child.id !== method?.id) walkRuby(child, facts, scope);
      return;
    }
    case "super":
      if (scope.method) facts.calls.push({ callee: scope.method, receiver: "super", line: line(node), column: column(node) });
      return;
    case "identifier":
      // `total` with no arguments and no receiver: a call, unless the method made it a variable.
      if (!scope.variables.has(node.text)) facts.calls.push({ callee: node.text, receiver: null, line: line(node), column: column(node) });
      return;
    case "constant":
      rubyUse(node, facts, scope);
      return;
    case "scope_resolution":
      if (rubyConstant(node)) rubyUse(node, facts, scope);
      else walkChildren(node);
      return;
    case "exception_variable":
      // `rescue Timeout::Error => error`: the list before it says what it is, and it is not the class called `Error`.
      rubyHide(namedChildren(node).map((child) => child.text), node, facts, scope, true);
      return;
    case "alias":
    case "undef":
    case "hash_key_symbol":
      return;
    case "for":
    case "in_clause":
    case "test_pattern":
    case "match_pattern": {
      // What the pattern names is bound by it, not read.
      const pattern = node.childForFieldName("pattern");
      if (pattern) {
        const names = new Set<string>();
        if (node.type === "for") rubyAssigned(pattern, names);
        else rubyPatternNames(pattern, names);
        rubyHide(names, pattern, facts, scope, true);
      }
      for (const child of namedChildren(node)) if (child.id !== pattern?.id) walkRuby(child, facts, scope);
      return;
    }
    case "string":
      sniffSql(node, facts);
      break;
    case "heredoc_body": {
      // What is interpolated stays in as a placeholder, so that `ALTER TABLE #{name} ADD ...` does not read as a table called `add`.
      const text = namedChildren(node)
        .map((child) => (child.type === "heredoc_content" ? child.text : child.type === "interpolation" ? "#{}" : ""))
        .join("");
      if (text.length >= 12 && looksLikeSql(text)) facts.tables.push(...tablesInSql(text, line(node)));
      break;
    }
    default:
      break;
  }
  walkChildren(node);
}

export function extractRuby(root: Node, facts: FileFacts): void {
  const variables = new Set<string>();
  const typed = new Set<string>();
  rubyVariables(root, variables, typed);
  walkRuby(root, facts, { nesting: [], owner: null, inDef: false, inBlock: false, method: null, variables, typed, attrs: new Set(), scopeEnd: endLine(root), bodyEnd: endLine(root), fields: new Set(), seen: new Set() });
}
