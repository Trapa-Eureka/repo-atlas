import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAliases } from "../src/indexer/aliases.js";
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

describe("Go modules", () => {
  it("skips a vendor folder written by `go mod vendor`, and reads the module path", () => {
    root = mkdtempSync(join(tmpdir(), "atlas-go-"));
    for (const [path, text] of Object.entries({
      "svc/go.mod": "module example.com/svc\n\ngo 1.22\n",
      "svc/main.go": "package main\n",
      "svc/vendor/modules.txt": "# github.com/x/y v1.0.0\n",
      "svc/vendor/github.com/x/y/y.go": "package y\n",
      "tools/vendor/kept.go": "package vendor\n",
    })) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", "."]);
    const walked = walk(root);
    expect(walked.files.map((file) => file.path)).toEqual(["svc/main.go", "tools/vendor/kept.go"]);
    expect(loadAliases(root, walked.configs).map((alias) => `${alias.prefix} -> ${alias.targets.join(", ")} (${alias.language})`)).toEqual([
      "example.com/svc -> svc (go)",
      "example.com/svc/ -> svc/ (go)",
    ]);
  });
});

describe("loadAliases", () => {
  it("maps a link: dependency to the folder it points at, for the package that declares it", () => {
    root = mkdtempSync(join(tmpdir(), "atlas-alias-"));
    mkdirSync(join(root, "apps/web"), { recursive: true });
    writeFileSync(join(root, "apps/web/package.json"), JSON.stringify({ name: "web", dependencies: { api: "link:./src/api", shared: "file:../../packages/shared", up: "file:../..", react: "^19.0.0", packed: "file:./vendor/packed.tgz", outside: "link:../../../outside" } }));
    const aliases = loadAliases(root, ["apps/web/package.json"]).filter((alias) => alias.scope === "apps/web");
    expect(aliases.map((alias) => `${alias.prefix} -> ${alias.targets.join(", ")}`)).toEqual([
      "api -> apps/web/src/api/src/index, apps/web/src/api/index",
      "api/ -> apps/web/src/api/src/, apps/web/src/api/",
      "shared -> packages/shared/src/index, packages/shared/index",
      "shared/ -> packages/shared/src/, packages/shared/",
      "up -> src/index, index",
      "up/ -> src/, ",
    ]);
  });
});
