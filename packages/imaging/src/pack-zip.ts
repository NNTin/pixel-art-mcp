/**
 * `sprites.zip`: every file `packSprites` wrote under its output directory, deflated -- the tail
 * end of `src/pixel_art_mcp/imaging/pixels.py::pack_sprites`'s `zipfile.ZipFile(...)` block.
 * Split into its own module so `pixels.ts` doesn't need to know archive internals.
 *
 * Uses `fflate` (`zipSync`): pure JS, zero dependencies, actively maintained. Not called out in
 * `docs/typescript-rewrite.md`'s stack table (which only flags the PNG/APNG/GIF encoders as
 * fidelity-risk items) since ZIP has no per-frame disposal/blend semantics to get wrong -- any
 * correct DEFLATE zip writer produces an equivalent archive, so this is a plain "pick a
 * well-maintained pure-JS option" choice, not a fidelity-risk one.
 */

import fs from "node:fs";
import path from "node:path";

import { zipSync } from "fflate";

function listFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

export function writeSpritesZip(outputDir: string): void {
  const files: string[] = [];
  listFiles(outputDir, files);
  files.sort();

  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    if (path.basename(file) === "sprites.zip") continue;
    const relative = path.relative(outputDir, file).split(path.sep).join("/");
    entries[relative] = fs.readFileSync(file);
  }

  fs.writeFileSync(path.join(outputDir, "sprites.zip"), zipSync(entries, { level: 6 }));
}
