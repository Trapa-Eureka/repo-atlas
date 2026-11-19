import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walk } from "../src/indexer/walk.js";

const FILES = ["src/a.ts", "build/plugin.ts", "vendor/lib.js", "dist/a.js", ".venv/site.py", "node_modules/pkg/index.js", "ignored/x.ts"];
let root = "";

function create(git: boolean): string {
  root = mkdtempSync(join(tmpdir(), "atlas-walk-"));
  for (const path of FILES) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), "export {};\n");
  }
  if (git) {
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    execFileSync("git", ["-C", root, "init", "-q"]);
    // Tracked on purpose: a build script folder and vendored source.
    execFileSync("git", ["-C", root, "add", "src/a.ts", "build/plugin.ts", "vendor/lib.js", "node_modules/pkg/index.js"]);
  }
  return root;
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("walk", () => {
  it("indexes tracked build and vendor folders, but not untracked output or node_modules", () => {
    expect(walk(create(true)).files.map((file) => file.path)).toEqual(["build/plugin.ts", "src/a.ts", "vendor/lib.js"]);
  });

  it("skips well-known output folders outside git", () => {
    expect(walk(create(false)).files.map((file) => file.path)).toEqual(["ignored/x.ts", "src/a.ts"]);
  });
});
