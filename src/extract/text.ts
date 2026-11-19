import type { DocRefFact, EnvFact, Language } from "./facts.js";

const ENV_NAME = "([A-Za-z_][A-Za-z0-9_]*)";

const SCRIPT_ENV = [
  new RegExp(`\\b(?:process|import\\.meta)\\.env\\.${ENV_NAME}`, "g"),
  new RegExp(`\\b(?:process|import\\.meta)\\.env\\[\\s*["'\`]${ENV_NAME}["'\`]\\s*\\]`, "g"),
  new RegExp(`\\bDeno\\.env\\.get\\(\\s*["'\`]${ENV_NAME}["'\`]`, "g"),
];

// `environ` alone is also what WSGI calls a request's variables, so it counts only as `os.environ`
// (or under an alias of `os`), after `from os import environ`, or after `environ = os.environ`.
const pythonEnv = (environ: string) => [
  new RegExp(`${environ}\\[\\s*["']${ENV_NAME}["']\\s*\\]`, "g"),
  new RegExp(`${environ}\\.get\\(\\s*["']${ENV_NAME}["']`, "g"),
  new RegExp(`\\bgetenv\\(\\s*["']${ENV_NAME}["']`, "g"),
];
const BARE_ENVIRON = "(?<![\\w.])environ";
const BINDS_ENVIRON = /^\s*(?:from\s+os\s+import\s+(?:\([^)]*\benviron\b|[^\n#]*\benviron\b)|environ\s*=\s*\w+\.environ\b)/m;
const OS_ALIAS = /^\s*import\s+os\s+as\s+(\w+)/gm;

function pythonPatterns(source: string): RegExp[] {
  const modules = ["os", ...[...source.matchAll(OS_ALIAS)].map((match) => match[1] ?? "os")];
  const patterns = pythonEnv(`(?<![\\w.])(?:${modules.join("|")})\\.environ`);
  return BINDS_ENVIRON.test(source) ? [...patterns, ...pythonEnv(BARE_ENVIRON)] : patterns;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) line++;
  return line;
}

/** Where each env key is first used, as an offset into `source`. */
export function envMatches(source: string, language: Language): { name: string; offset: number }[] {
  const patterns = language === "python" ? pythonPatterns(source) : SCRIPT_ENV;
  const found: { name: string; offset: number }[] = [];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) if (match[1]) found.push({ name: match[1], offset: match.index });
  }
  return found.sort((a, b) => a.offset - b.offset);
}

/** Env keys used in `source`. `isCode` can veto a match by its offset, for example one inside a string or a comment. */
export function envUses(source: string, language: Language, isCode: (offset: number) => boolean = () => true): EnvFact[] {
  const found = new Map<string, EnvFact>();
  for (const { name, offset } of envMatches(source, language)) {
    if (!found.has(name) && isCode(offset)) found.set(name, { name, op: "use", line: lineOf(source, offset) });
  }
  return [...found.values()];
}

/** Keys declared in a template such as `.env.example`. Values are never read. */
export function envDeclarations(source: string): EnvFact[] {
  const found: EnvFact[] = [];
  source.split("\n").forEach((text, index) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text);
    if (match?.[1]) found.push({ name: match[1], op: "declare", line: index + 1 });
  });
  return found;
}

const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

export function markdownRefs(source: string): DocRefFact[] {
  const refs: DocRefFact[] = [];
  let inFence = false;
  source.split("\n").forEach((text, index) => {
    if (/^\s*(?:```|~~~)/.test(text)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const line = index + 1;
    for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = (match[1] ?? "").split("#")[0] ?? "";
      if (target && !EXTERNAL_LINK.test(target)) refs.push({ target, kind: "link", line });
    }
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const target = (match[1] ?? "").trim();
      if (target && target.length <= 200) refs.push({ target, kind: "code", line });
    }
  });
  return refs;
}
