// Measures what atlas misses on a TypeScript/JavaScript repository: every call and import the
// TypeScript compiler can resolve to a file of that repository is looked up in atlas's graph.
// It needs no install in the target repository, so calls the compiler cannot resolve without the
// repository's dependencies are left out of the count.
//
//   pnpm build && node scripts/recall.mjs <repository> [--misses <n> [reason prefix]]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const [repoArg, , missArg, only] = process.argv.slice(2);
if (!repoArg) throw new Error("usage: node scripts/recall.mjs <repository> [--misses <n> [reason prefix]]");
const repo = resolve(repoArg);
const cli = join(dirname(fileURLToPath(import.meta.url)), "../dist/cli/main.js");
const graph = JSON.parse(execFileSync("node", [cli, "-C", repo, "export"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
const SCRIPT = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const files = graph.nodes.filter((n) => n.kind === "file" && SCRIPT.test(n.file)).map((n) => n.file);
const indexed = new Set(files);
const symbols = new Set(graph.nodes.filter((n) => n.kind === "symbol").map((n) => n.id));
const fileOf = (id) => id.replace(/^(?:file|sym):/, "").replace(/#.*/, "");
const atlasCalls = new Set(graph.edges.filter((e) => e.kind === "calls").map((e) => `${fileOf(e.src)}|${e.dst}`));
const atlasImports = new Set(graph.edges.filter((e) => e.kind === "imports" && e.dst.startsWith("file:")).map((e) => `${fileOf(e.src)}|${fileOf(e.dst)}`));

// Group files by their nearest tsconfig/jsconfig so that each group gets its own path aliases.
const configCache = new Map();
function nearestConfig(file) {
  let dir = dirname(join(repo, file));
  while (dir.startsWith(repo)) {
    if (!configCache.has(dir)) configCache.set(dir, ["tsconfig.json", "jsconfig.json"].map((n) => join(dir, n)).find(existsSync) ?? null);
    if (configCache.get(dir)) return configCache.get(dir);
    dir = dirname(dir);
  }
  return "";
}
const groups = new Map();
for (const file of files) {
  const key = nearestConfig(file);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(file);
}

const rel = (abs) => relative(repo, abs).split("\\").join("/");
const truthCalls = new Map(); // key -> { form, hasNode }
const truthImports = new Set();
const skipped = { interface: 0, external: 0, unresolved: 0 };

function targetOf(declaration) {
  const source = declaration.getSourceFile();
  if (!source) return { external: true };
  const file = rel(source.fileName);
  if (source.isDeclarationFile || file.startsWith("..") || file.includes("node_modules/") || !indexed.has(file)) return { external: true };
  const insideFunction = (node) => {
    for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p) && p !== node) return true;
    return false;
  };
  const className = (node) => (node.parent && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) ? node.parent.name?.text ?? (ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent.name.getText() : null) : null);
  if (ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration) || ts.isCallSignatureDeclaration(declaration) || ts.isConstructSignatureDeclaration(declaration) || ts.isFunctionTypeNode(declaration)) return { interface: true };
  let name = null, shape = "other";
  if (ts.isFunctionDeclaration(declaration) && declaration.name) [name, shape] = [declaration.name.text, insideFunction(declaration) ? "nested function" : "function"];
  else if (ts.isClassDeclaration(declaration) && declaration.name) [name, shape] = [declaration.name.text, "class"];
  else if (ts.isConstructorDeclaration(declaration)) [name, shape] = [className(declaration), "class"];
  else if ((ts.isMethodDeclaration(declaration) || ts.isGetAccessor(declaration) || ts.isSetAccessor(declaration)) && className(declaration)) [name, shape] = [`${className(declaration)}.${declaration.name.getText()}`, "method"];
  else if (ts.isMethodDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) [name, shape] = [declaration.name.getText(), "object member"];
  else if (ts.isPropertyDeclaration(declaration) && className(declaration)) [name, shape] = [`${className(declaration)}.${declaration.name.getText()}`, "class property"];
  else if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    const init = declaration.initializer;
    const isFn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
    const isClass = init && ts.isClassExpression(init);
    [name, shape] = [declaration.name.text, insideFunction(declaration) ? "nested function" : isFn ? "function" : isClass ? "class" : "variable holding a function"];
  } else if (ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) {
    const parent = declaration.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) [name, shape] = [parent.name.text, insideFunction(parent) ? "nested function" : "function"];
    else if (ts.isPropertyAssignment(parent)) [name, shape] = [parent.name.getText(), "object member"];
    else if (ts.isPropertyDeclaration(parent) && className(parent)) [name, shape] = [`${className(parent)}.${parent.name.getText()}`, "class property"];
    else shape = "anonymous function";
  } else if (ts.isParameter(declaration)) shape = "parameter (callback)";
  if (!name) return { shape };
  return { file, name, shape };
}

function reasonOf(node, target, from) {
  const form = formOf(node);
  if (!target.name) return `target is not a symbol (${target.shape})`;
  if (target.shape === "nested function") return "target is a nested function";
  if (!symbols.has(`sym:${target.file}#${target.name}`)) return `target is not a symbol (${target.shape})`;
  const callee = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName : ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  if (ts.isIdentifier(callee)) {
    const simple = target.name.split(".").pop();
    if (callee.text !== simple && callee.text !== target.name.split(".")[0]) return "called under another name (alias, default or CommonJS export)";
    return target.file === from ? "same name, same file" : "same name, other file";
  }
  if (form === "this.method()") return "this.method() not linked";
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return target.shape === "method" ? "method on a variable (needs its type)" : "member of a namespace or object";
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return "JSX member tag <A.B>";
  return "method through a chain or a field (needs types)";
}

function formOf(node) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return "JSX <Component>";
  if (ts.isNewExpression(node)) return "new Class()";
  if (ts.isTaggedTemplateExpression(node)) return "tagged template";
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return "name()";
  if (ts.isPropertyAccessExpression(callee)) {
    const object = callee.expression;
    if (object.kind === ts.SyntaxKind.ThisKeyword) return "this.method()";
    if (object.kind === ts.SyntaxKind.SuperKeyword) return "super.method()";
    if (ts.isIdentifier(object)) return "object.method()";
    if (ts.isPropertyAccessExpression(object) && object.expression.kind === ts.SyntaxKind.ThisKeyword) return "this.field.method()";
    return "chained a.b().c() / a.b.c()";
  }
  return "other (call of a call, element access)";
}

for (const [config, group] of groups) {
  let options = { allowJs: true, jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 };
  if (config) {
    const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config ?? {}, ts.sys, dirname(config));
    options = { ...options, ...parsed.options };
  }
  options = { ...options, allowJs: true, noEmit: true, skipLibCheck: true, types: [], composite: false, incremental: false, noResolve: false };
  const program = ts.createProgram(group.map((f) => join(repo, f)), options);
  const checker = program.getTypeChecker();
  const mine = new Set(group);

  for (const source of program.getSourceFiles()) {
    const from = rel(source.fileName);
    if (!mine.has(from)) continue;

    // imports
    for (const statement of source.statements) {
      const spec = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      if (!spec) continue;
      const resolved = ts.resolveModuleName(spec, source.fileName, options, ts.sys).resolvedModule;
      if (!resolved) continue;
      const to = rel(resolved.resolvedFileName);
      if (indexed.has(to) && to !== from) truthImports.add(`${from}|${to}`);
    }

    const addImport = (spec) => {
      const resolved = ts.resolveModuleName(spec, source.fileName, options, ts.sys).resolvedModule;
      const to = resolved ? rel(resolved.resolvedFileName) : null;
      if (to && indexed.has(to) && to !== from) truthImports.add(`${from}|${to}`);
    };

    // calls
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]) && ((ts.isIdentifier(node.expression) && node.expression.text === "require") || node.expression.kind === ts.SyntaxKind.ImportKeyword)) addImport(node.arguments[0].text);
      const isCall = ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || ts.isTaggedTemplateExpression(node);
      if (isCall) {
        let declaration;
        try {
          declaration = checker.getResolvedSignature(node)?.declaration;
          if (!declaration && (ts.isNewExpression(node) || ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
            const expr = ts.isNewExpression(node) ? node.expression : node.tagName;
            let symbol = checker.getSymbolAtLocation(expr);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            declaration = symbol?.declarations?.[0];
          }
        } catch {
          declaration = undefined;
        }
        let inside = false;
        if (declaration) for (let p = node.parent; p; p = p.parent) if (p === declaration || (ts.isVariableDeclaration(declaration) && p === declaration.initializer)) inside = true;
        if (inside) skipped.recursive = (skipped.recursive ?? 0) + 1;
        else if (!declaration) skipped.unresolved++;
        else {
          const target = targetOf(declaration);
          if (target.external) skipped.external++;
          else if (target.interface) skipped.interface++;
          else {
            const id = target.name ? `sym:${target.file}#${target.name}` : null;
            const key = `${from}|${id ?? `${target.shape}@${rel(declaration.getSourceFile()?.fileName ?? "?")}:${declaration.pos}`}`;
            if (!truthCalls.has(key)) {
              const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              truthCalls.set(key, { form: formOf(node), shape: target.shape, hasNode: id !== null && symbols.has(id), found: id !== null && atlasCalls.has(`${from}|${id}`), where: `${from}:${line}`, text: node.getText().split("\n")[0].slice(0, 70), id, reason: reasonOf(node, target, from) });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const calls = [...truthCalls.values()];
const tally = (rows, key) => {
  const out = new Map();
  for (const row of rows) {
    const entry = out.get(row[key]) ?? { total: 0, found: 0 };
    entry.total++;
    if (row.found) entry.found++;
    out.set(row[key], entry);
  }
  return [...out].sort((a, b) => b[1].total - b[1].total || b[1].total - a[1].total).sort((a, b) => b[1].total - a[1].total);
};
const importsFound = [...truthImports].filter((key) => atlasImports.has(key)).length;
const result = {
  repo: repoArg,
  scriptFiles: files.length,
  imports: { truth: truthImports.size, found: importsFound, missed: [...truthImports].filter((key) => !atlasImports.has(key)).slice(0, 8) },
  calls: { truth: calls.length, found: calls.filter((c) => c.found).length, withNode: calls.filter((c) => c.hasNode).length, foundWithNode: calls.filter((c) => c.hasNode && c.found).length },
  byForm: tally(calls, "form").map(([k, v]) => [k, v.total, v.found]),
  byTarget: tally(calls, "shape").map(([k, v]) => [k, v.total, v.found]),
  byReason: tally(calls.filter((c) => !c.found), "reason").map(([k, v]) => [k, v.total, 0]),
  skipped,
};
console.log(`== ${repoArg}: ${files.length} script files`);
console.log(`imports  truth ${result.imports.truth}  found ${importsFound}  recall ${pct(importsFound, result.imports.truth)}`);
console.log(`calls    truth ${result.calls.truth}  found ${result.calls.found}  recall ${pct(result.calls.found, result.calls.truth)}   | targets atlas has as symbols: ${result.calls.foundWithNode}/${result.calls.withNode} ${pct(result.calls.foundWithNode, result.calls.withNode)}`);
console.log(`not counted: ${skipped.external} calls into packages/built-ins, ${skipped.interface} resolved only to an interface or type, ${skipped.unresolved} the compiler could not resolve`);
console.log("by call form:   " + result.byForm.map(([k, t, f]) => `${k} ${f}/${t}`).join("  ·  "));
console.log("by target kind: " + result.byTarget.map(([k, t, f]) => `${k} ${f}/${t}`).join("  ·  "));
if (missArg) {
  const misses = calls.filter((c) => !c.found && c.hasNode && (!only || c.reason.startsWith(only)));
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const m of misses.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).slice(0, +missArg).map((x) => x[1])) console.log(`  MISS [${m.form}] ${m.where}  ${m.text}  -> ${m.id}`);
  for (const key of result.imports.missed) console.log(`  MISS import ${key}`);
}
process.stdout.write(`JSON ${JSON.stringify(result)}\n`);
