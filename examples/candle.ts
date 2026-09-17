import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";

/**
 * A surface candle: the entire silhouette fits the profile's seven useful rows.
 *
 * Ported from `candle.py` -- see `docs/typescript-rewrite.md` and this repo's
 * `execute_pixel_script` docstring for the `export default (scene, referenceImages) => void`
 * contract this replaces Python's module-level `art.save(scene)` with.
 */
export default function main(scene: Scene): void {
  const art = new PixelArt(
    { D: "#47404a", W: "#f0dfb2", S: "#b7a980", F: "#ee9046", L: "#fff2a5" },
    { 0: [16, 16], 90: [16, 16], 180: [16, 16], 270: [16, 16] },
  );
  for (const angle of [0, 90, 180, 270]) {
    const body = Canvas.fromRows([".WWW.", ".WSW.", ".WSW.", "DDDDD", ".DDD."]);
    art.layer("wax and dish", angle, body, { x: 5, y: 3, min_pixels: 16, connected: true });
    art.layer("flame", angle, Canvas.fromRows([".F.", "FLF", ".L."]), {
      x: 6,
      y: 1,
      min_pixels: 5,
      connected: true,
    });
  }
  art.save(scene);
}
