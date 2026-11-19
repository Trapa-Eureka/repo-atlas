import type { Node } from "web-tree-sitter";
import type { FileFacts, ImportedName, SymbolFact } from "./facts.js";
import { looksLikeSql, tablesInSql } from "./sql.js";

const line = (node: Node): number => node.startPosition.row + 1;
const endLine = (node: Node): number => node.endPosition.row + 1;

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
  className: string | null;
}

const SCRIPT_ROOT: ScriptScope = { topLevel: true, exported: false, isDefault: false, className: null };
const SCRIPT_NESTED: ScriptScope = { topLevel: false, exported: false, isDefault: false, className: null };

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

function scriptCall(node: Node, facts: FileFacts): void {
  const callee = node.childForFieldName("function");
  if (!callee) return;
  if (callee.type === "import" || (callee.type === "identifier" && callee.text === "require")) {
    const specifier = firstStringArgument(node);
    if (specifier) facts.imports.push({ specifier, names: [], reexport: false, star: false, line: line(node) });
    return;
  }
  if (callee.type === "identifier") {
    facts.calls.push({ callee: callee.text, receiver: null, line: line(node) });
    return;
  }
  if (callee.type !== "member_expression") return;
  const object = callee.childForFieldName("object");
  const property = callee.childForFieldName("property");
  if (!object || !property) return;
  if (property.text === "from" && !NOT_A_QUERY_BUILDER.has(object.text)) {
    const table = firstStringArgument(node);
    if (table && /^[A-Za-z_]\w*$/.test(table)) facts.tables.push({ name: table.toLowerCase(), op: "read", line: line(node) });
  }
  if (object.type === "identifier" || object.type === "this") {
    facts.calls.push({ callee: property.text, receiver: object.text, line: line(node) });
  }
}

function walkScript(node: Node, facts: FileFacts, scope: ScriptScope): void {
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
      if (source) {
        const clause = namedChildren(node).find((child) => child.type === "export_clause");
        const names: ImportedName[] = [];
        for (const specifier of clause ? namedChildren(clause) : []) {
          const imported = specifier.childForFieldName("name")?.text;
          const local = specifier.childForFieldName("alias")?.text ?? imported;
          if (imported && local) names.push({ local, imported });
        }
        facts.imports.push({ specifier: unquote(source.text), names, reexport: true, star: !clause, line: line(node) });
        return;
      }
      const isDefault = children(node).some((child) => child.type === "default");
      for (const child of namedChildren(node)) walkScript(child, facts, { ...scope, exported: scope.topLevel, isDefault });
      return;
    }
    case "function_declaration":
    case "generator_function_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.topLevel) {
        addSymbol(facts, { name, kind: "function", line: line(node), endLine: endLine(node), exported: scope.exported, isDefault: scope.isDefault });
      }
      break;
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name && scope.topLevel) {
        addSymbol(facts, { name, kind: "class", line: line(node), endLine: endLine(node), exported: scope.exported, isDefault: scope.isDefault });
        for (const child of namedChildren(node)) walkScript(child, facts, { ...SCRIPT_NESTED, className: name });
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
    case "lexical_declaration":
    case "variable_declaration": {
      for (const declarator of namedChildren(node)) {
        const name = declarator.childForFieldName("name");
        const value = declarator.childForFieldName("value");
        if (scope.topLevel && name?.type === "identifier" && value && SCRIPT_FUNCTION_VALUES.has(value.type)) {
          addSymbol(facts, { name: name.text, kind: "function", line: line(node), endLine: endLine(node), exported: scope.exported, isDefault: false });
        }
      }
      break;
    }
    case "call_expression":
      scriptCall(node, facts);
      break;
    case "new_expression": {
      const constructor = node.childForFieldName("constructor");
      if (constructor?.type === "identifier") facts.calls.push({ callee: constructor.text, receiver: null, line: line(node) });
      break;
    }
    case "jsx_opening_element":
    case "jsx_self_closing_element": {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier" && /^[A-Z]/.test(name.text)) facts.calls.push({ callee: name.text, receiver: null, line: line(node) });
      break;
    }
    case "string":
    case "template_string":
      sniffSql(node, facts);
      break;
    default:
      break;
  }

  const inner = node.type === "program" || node.type === "class_body" ? scope : SCRIPT_NESTED;
  for (const child of namedChildren(node)) walkScript(child, facts, inner);
}

export function extractScript(root: Node, facts: FileFacts): void {
  walkScript(root, facts, SCRIPT_ROOT);
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
