import { execFileSync } from "node:child_process";
import type { ChangedFile, LineRange } from "../query/changes.js";

/** What the working tree was compared with. */
export interface Comparison {
  /** The revision as it was asked for (`HEAD` when nothing was). */
  base: string;
  /** The commit the comparison starts from: where the current branch left `base`. */
  commit: string;
  files: ChangedFile[];
}

const STATUS: Record<string, ChangedFile["status"]> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified" };

function git(root: string, args: string[]): string {
  // `core.quotePath=false` keeps non-ASCII paths as they are instead of octal escapes.
  return execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });
}

/** What git said when it failed, or nothing when it only exited with a status. */
function reason(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? (stderr.trim().split("\n")[0] ?? "") : "";
}

/** A path as a patch header writes it: bare, or in double quotes with C escapes when it holds a quote, a backslash or a control character. */
function headerPath(text: string): string {
  const bare = text.replace(/\t$/, "");
  if (!bare.startsWith('"')) return bare;
  const bytes: number[] = [];
  const body = bare.slice(1, bare.lastIndexOf('"'));
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      index += 3;
    } else {
      bytes.push(simple[body[index + 1] ?? ""] ?? 92);
      index++;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The lines each file has now that it did not have before, read from a patch made with `-U0`.
 * Where lines were only taken out, `gaps` holds the line they used to follow.
 */
export function parsePatch(patch: string): Map<string, { ranges: LineRange[]; gaps: number[] }> {
  const files = new Map<string, { ranges: LineRange[]; gaps: number[] }>();
  let current: { ranges: LineRange[]; gaps: number[] } | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      const path = line.slice(4);
      // A deleted file has no lines left to point at.
      if (path === "/dev/null") continue;
      current = { ranges: [], gaps: [] };
      files.set(headerPath(path).replace(/^b\//, ""), current);
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk || !current) continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) current.gaps.push(start);
      else current.ranges.push([start, start + count - 1]);
    }
  }
  return files;
}

/**
 * What differs between the working tree and the point where the current branch left `base`:
 * commits made since, uncommitted edits, and files git does not track yet. Paths are relative to `root`.
 */
export function compare(root: string, base = "HEAD"): Comparison {
  try {
    git(root, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`${root} is not inside a git repository. atlas diff reads what changed from git.`);
  }
  try {
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    throw new Error("This repository has no commit yet, so there is nothing to compare the working tree with.");
  }
  // A name that starts with a dash would be read by git as an option.
  if (base.startsWith("-")) throw new Error(`Not a revision: ${base}`);
  let commit: string;
  try {
    commit = git(root, ["merge-base", base, "HEAD"]).trim();
  } catch (error) {
    const detail = reason(error);
    throw new Error(
      detail
        ? `Cannot compare with ${base}: ${detail}`
        : `Cannot compare with ${base}: it shares no commit with HEAD in this clone. In a shallow clone, fetch more history first (git fetch --unshallow).`,
    );
  }

  const files = new Map<string, ChangedFile>();
  // `-z` gives each path as it is, with a NUL after it: `M\0path\0`, `R100\0old\0new\0`.
  const listed = git(root, ["diff", "--relative", "--name-status", "-z", "-M", commit]).split("\0");
  for (let index = 0; index + 1 < listed.length; ) {
    const code = (listed[index++] ?? "")[0] ?? "";
    const from = code === "R" || code === "C" ? listed[index++] : undefined;
    const path = listed[index++] ?? "";
    if (!path) continue;
    files.set(path, { path, status: STATUS[code] ?? "modified", ranges: [], gaps: [], ...(code === "R" && from ? { from } : {}) });
  }
  const patch = git(root, ["diff", "--relative", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U0", "-M", commit]);
  for (const [path, lines] of parsePatch(patch)) {
    const file = files.get(path);
    if (file) Object.assign(file, lines);
  }
  for (const path of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
    if (path && !files.has(path)) files.set(path, { path, status: "untracked", ranges: [], gaps: [] });
  }
  return { base, commit, files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}
