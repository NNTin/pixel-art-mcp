import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";

/**
 * Edit the previous saved chair revision, retaining named views and layers.
 *
 * Ported from `modify_chair.py`, which reads the previous revision via `PixelArt.load(scene)`
 * before mutating it -- the TS port uses `PixelArt.load`/`PixelArt.save` from
 * `@pixel-art-mcp/pixel-core` the same way. `pose.rows`/`layer.name` are the same plain
 * snake_case fields `pixel-core`'s `toDict()`/`fromDict()` round-trip through (see
 * `packages/pixel-core/src/types.ts`), so mutating them in place and calling `art.save(scene)`
 * is the direct equivalent of the Python source's in-place dict mutation.
 */
export default function main(scene: Scene): void {
  const art = PixelArt.load(scene);
  art.palette["C"] = "#aa466b";
  art.palette["T"] = "#e69eb0";
  for (const layer of art.layers) {
    if (layer.name !== "body") continue;
    for (const pose of layer.poses) {
      const canvas = Canvas.fromRows(pose.rows);
      if (pose.angle === 0 || pose.angle === 180) {
        canvas.rect(3, 8, 10, 2, "D").rect(4, 8, 8, 1, "H");
        canvas.rect(4, 9, 8, 2, "C").rect(5, 9, 6, 1, "T");
      } else {
        const x = pose.angle === 90 ? 2 : 11;
        canvas.rect(x, 8, 3, 3, "D").rect(x + 1, 9, 1, 2, "H");
      }
      pose.rows = canvas.rows;
    }
  }
  art.save(scene);
}
