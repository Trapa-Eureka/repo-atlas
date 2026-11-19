// Renders an HTML string to a PNG with headless Chrome. Shared by the two image scripts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const assets = join(repo, "assets");

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function chrome() {
  const found = CANDIDATES.find((path) => path && existsSync(path));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH to a Chrome or Chromium executable.");
  return found;
}

/** Writes `assets/<name>.png` from `html`, at `width` x `height` CSS pixels times `scale`. */
export function render(name, html, { width, height, scale = 1 }) {
  const work = mkdtempSync(join(tmpdir(), "atlas-shot-"));
  try {
    const page = join(work, `${name}.html`);
    writeFileSync(page, html);
    execFileSync(
      chrome(),
      ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`, `--screenshot=${join(assets, `${name}.png`)}`, pathToFileURL(page).href],
      { stdio: "ignore" },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.stderr.write(`assets/${name}.png\n`);
}
