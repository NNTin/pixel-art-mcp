/**
 * A downloadable, self-contained sprite player; no server or CDN needed. Verbatim port of
 * `src/pixel_art_mcp/imaging/player.py` (44 lines) plus its `player.html` template (see
 * `templates.ts`).
 */

import fs from "node:fs";
import path from "node:path";

import { renderOptionsFrames, type RenderOptions } from "@pixel-art-mcp/schema";

import { PLAYER_HTML_TEMPLATE } from "./templates.js";

export interface ExportPlayerExtras {
  comparison?: Record<string, unknown> | null;
  target?: Record<string, unknown> | null;
  offImage?: string | null;
}

export function exportPlayer(
  outputDir: string,
  options: RenderOptions,
  extras: ExportPlayerExtras = {},
): void {
  function encode(filename: string): string {
    return fs.readFileSync(path.join(outputDir, filename)).toString("base64");
  }

  const rawComparison = extras.comparison ?? null;
  const comparison = rawComparison
    ? {
        ...rawComparison,
        image: encode(rawComparison["image"] as string),
        offImage: rawComparison["off_image"] ? encode(rawComparison["off_image"] as string) : null,
      }
    : null;

  const data = {
    width: options.width,
    height: options.height,
    angles: options.angles,
    frames: renderOptionsFrames(options),
    fps: options.fps,
    image: encode("spritesheet.png"),
    offImage: extras.offImage ? encode(extras.offImage) : null,
    target: extras.target ?? null,
    comparison,
  };
  // Escape HTML delimiters so target metadata cannot terminate the inline script.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = PLAYER_HTML_TEMPLATE.replace("__PLAYER_DATA__", json);
  fs.writeFileSync(path.join(outputDir, "preview.html"), html, "utf-8");
}
