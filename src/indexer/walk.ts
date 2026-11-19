import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { languageOf } from "../extract/index.js";

export const MAX_FILE_BYTES = 1024 * 1024;

const IGNORED_FOLDERS = new Set([
  ".git", ".atlas", "node_modules", "dist", "build", "out", "coverage", "vendor", "target",
  ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache",
]);
const PROJECT_CONFIGS = new Set(["tsconfig.json", "jsconfig.json", "package.json"]);

export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** tsconfig.json / jsconfig.json / package.json paths, used only to resolve import aliases. */
  configs: string[];
  skippedLarge: number;
}

function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function diskFiles(root: string, folder = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_FOLDERS.has(entry.name)) found.push(...diskFiles(root, path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/** Lists the files to index. Inside a git repository this honours `.gitignore`; elsewhere it skips well-known output folders. */
export function walk(root: string): WalkResult {
  const result: WalkResult = { files: [], configs: [], skippedLarge: 0 };
  for (const path of (gitFiles(root) ?? diskFiles(root)).sort()) {
    if (path.split("/").some((segment) => IGNORED_FOLDERS.has(segment))) continue;
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
