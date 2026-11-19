import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { languageOf } from "../extract/index.js";

export const MAX_FILE_BYTES = 1024 * 1024;

/** Never indexed, even when tracked by git. */
const ALWAYS_IGNORED = new Set([".git", ".atlas", "node_modules"]);
/** Output and cache folders, skipped wherever git does not vouch for them: outside a repository, and for untracked files inside one. */
const IGNORED_WITHOUT_GIT = new Set([
  ...ALWAYS_IGNORED, "dist", "build", "out", "coverage", "vendor", "target",
  ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache",
]);
const PROJECT_CONFIGS = new Set(["tsconfig.json", "jsconfig.json", "package.json", "go.mod", "Cargo.toml"]);

export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** tsconfig.json / jsconfig.json / package.json / go.mod / Cargo.toml paths, used only to resolve import aliases. */
  configs: string[];
  skippedLarge: number;
}

function git(root: string, flags: string[]): string[] | null {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", ...flags, "-z"], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

const skips = (path: string, folders: ReadonlySet<string>): boolean => path.split("/").some((segment) => folders.has(segment));

/**
 * Tracked files, plus untracked files that `.gitignore` does not exclude. A tracked `build/` or
 * `vendor/` folder is source someone chose to commit; an untracked one is output nobody has
 * ignored yet, so it gets the same treatment as outside git.
 */
function gitFiles(root: string): string[] | null {
  const tracked = git(root, ["-c"]);
  if (!tracked) return null;
  const untracked = git(root, ["-o", "--exclude-standard"]) ?? [];
  return [...tracked.filter((path) => !skips(path, ALWAYS_IGNORED)), ...untracked.filter((path) => !skips(path, IGNORED_WITHOUT_GIT))];
}

function diskFiles(root: string, folder = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_WITHOUT_GIT.has(entry.name)) found.push(...diskFiles(root, path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/** Lists the files to index. Inside a git repository this honours `.gitignore`; elsewhere it skips well-known output folders. */
export function walk(root: string): WalkResult {
  const result: WalkResult = { files: [], configs: [], skippedLarge: 0 };
  const paths = (gitFiles(root) ?? diskFiles(root)).sort();
  // `vendor/modules.txt` is what `go mod vendor` writes: that folder holds copies of dependencies, tracked or not.
  const vendored = paths.filter((path) => basename(path) === "modules.txt" && basename(dirname(path)) === "vendor").map((path) => `${dirname(path)}/`);
  for (const path of paths) {
    if (vendored.some((folder) => path.startsWith(folder))) continue;
    if (PROJECT_CONFIGS.has(basename(path))) {
      result.configs.push(path);
      continue;
    }
    if (!languageOf(path)) continue;
    let stat;
    try {
      stat = statSync(join(root, path));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      result.skippedLarge++;
      continue;
    }
    result.files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return result;
}
