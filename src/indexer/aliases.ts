import { readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { PathAlias } from "./link.js";

/** Removes comments and trailing commas so a tsconfig can be read with `JSON.parse`. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function underFolder(folder: string, path: string): string {
  const joined = posix.normalize(posix.join(folder || ".", path));
  return joined === "." ? "" : joined;
}

function tsconfigAliases(folder: string, config: Record<string, unknown>): PathAlias[] {
  const options = config.compilerOptions;
  if (!options || typeof options !== "object") return [];
  const { baseUrl, paths } = options as { baseUrl?: unknown; paths?: unknown };
  const base = underFolder(folder, typeof baseUrl === "string" ? baseUrl : ".");
  const aliases: PathAlias[] = [];

  if (paths && typeof paths === "object") {
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      const exact = !pattern.includes("*");
      aliases.push({
        scope: folder,
        prefix: exact ? pattern : pattern.slice(0, pattern.indexOf("*")),
        exact,
        targets: targets
          .filter((target): target is string => typeof target === "string")
          .map((target) => (exact ? underFolder(base, target) : withSlash(underFolder(base, target.split("*")[0] ?? "")))),
      });
    }
  }
  if (typeof baseUrl === "string") aliases.push({ scope: folder, prefix: "", exact: false, targets: [withSlash(base)] });
  return aliases;
}

function withSlash(target: string): string {
  return target === "" || target.endsWith("/") ? target : `${target}/`;
}

/** `"some-name": "link:./src/api"` (or `file:`) in a package.json: a folder of this repository imported by a package name. */
function linkedFolders(folder: string, manifest: Record<string, unknown>): PathAlias[] {
  const aliases: PathAlias[] = [];
  for (const key of ["dependencies", "devDependencies"]) {
    const dependencies = manifest[key];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const [name, version] of Object.entries(dependencies)) {
      const target = typeof version === "string" ? /^(?:link|file):(\.{1,2}\/.*|\.)$/.exec(version)?.[1] : undefined;
      if (!target || /\.tgz$/.test(target)) continue;
      const linked = underFolder(folder, target).replace(/\/$/, "");
      if (linked.startsWith("..")) continue;
      const under = (path: string) => (linked ? `${linked}/${path}` : path);
      aliases.push({ scope: folder, prefix: name, exact: true, targets: [under("src/index"), under("index")] }, { scope: folder, prefix: `${name}/`, exact: false, targets: [under("src/"), under("")] });
    }
  }
  return aliases;
}

function packageAliases(folder: string, manifest: Record<string, unknown>): PathAlias[] {
  const name = manifest.name;
  if (typeof name !== "string" || folder === "") return [];
  const entries = [`${folder}/src/index`, `${folder}/index`];
  for (const key of ["source", "main", "module"]) {
    const entry = manifest[key];
    if (typeof entry === "string") entries.unshift(underFolder(folder, entry).replace(/\.(?:[cm]?js|d\.ts)$/, ""), underFolder(folder, entry.replace(/^(?:\.\/)?dist\//, "src/")).replace(/\.(?:[cm]?js|d\.ts)$/, ""));
  }
  return [
    { scope: "", prefix: name, exact: true, targets: entries },
    { scope: "", prefix: `${name}/`, exact: false, targets: [`${folder}/src/`, `${folder}/`] },
  ];
}

/** Import aliases declared by the repository: tsconfig `paths` / `baseUrl`, and workspace package names. */
export function loadAliases(root: string, configs: string[]): PathAlias[] {
  const aliases: PathAlias[] = [];
  for (const path of configs) {
    const json = readJson(join(root, path));
    if (!json) continue;
    const folder = posix.dirname(path) === "." ? "" : posix.dirname(path);
    aliases.push(...(basename(path) === "package.json" ? [...packageAliases(folder, json), ...linkedFolders(folder, json)] : tsconfigAliases(folder, json)));
  }
  return aliases;
}
