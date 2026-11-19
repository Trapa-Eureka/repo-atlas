import type { DocRefFact, EnvFact, Language } from "./facts.js";

const ENV_NAME = "([A-Za-z_][A-Za-z0-9_]*)";

const SCRIPT_ENV = [
  new RegExp(`\\b(?:process|import\\.meta)\\.env\\.${ENV_NAME}`, "g"),
  new RegExp(`\\b(?:process|import\\.meta)\\.env\\[\\s*["'\`]${ENV_NAME}["'\`]\\s*\\]`, "g"),
  new RegExp(`\\bDeno\\.env\\.get\\(\\s*["'\`]${ENV_NAME}["'\`]`, "g"),
];

const PYTHON_ENV = [
  new RegExp(`\\benviron\\[\\s*["']${ENV_NAME}["']\\s*\\]`, "g"),
  new RegExp(`\\benviron\\.get\\(\\s*["']${ENV_NAME}["']`, "g"),
  new RegExp(`\\bgetenv\\(\\s*["']${ENV_NAME}["']`, "g"),
];

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) line++;
  return line;
}

export function envUses(source: string, language: Language): EnvFact[] {
  const patterns = language === "python" ? PYTHON_ENV : SCRIPT_ENV;
  const found = new Map<string, EnvFact>();
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const name = match[1];
      if (name && !found.has(name)) found.set(name, { name, op: "use", line: lineOf(source, match.index) });
    }
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
