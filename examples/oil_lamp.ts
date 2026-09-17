import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";

/**
 * Six-color lamp with a stable glass outline and a separately authored flame.
 *
 * Ported from `oil_lamp.py`. Frame 0 is the "off" pose (dark lantern, no flame); frames 1-8
 * alternate the flame's stamped position by one row to read as a flicker, matching the
 * `oil-lamp` example spec's `clips.flame` (`frames: 1..8`, `off_frame: 0`) in
 * `examples/asset-specs.json`.
 */
export default function main(scene: Scene): void {
  const art = new PixelArt(
    { D: "#303a42", M: "#769b9c", G: "#e0b854", C: "#315963", F: "#ea823d", L: "#fff0af" },
    { 0: [16, 32], 90: [16, 32], 180: [16, 32], 270: [16, 32] },
  );
  for (const angle of [0, 90, 180, 270]) {
    const body = new Canvas(16, 32);
    body.stamp(4, 3, ["..DDDD..", ".D....D.", "D......D", "D......D", "D......D", "D......D"]);
    body.stamp(4, 8, [
      "..DDDD..",
      ".DGGGGD.",
      "..DCCD..",
      "..MCCM..",
      ".MCCCCM.",
      ".MCCCCM.",
      ".MCCCCM.",
      ".MCCCCM.",
      ".MCCCCM.",
      "..MCCM..",
      "..DDDD..",
    ]);
    body.stamp(3, 19, ["..DDDDDD..", ".DGGGGGGD.", "DGGGGGGGGD", ".DDDDDDDD."]);
    body.rect(7, 10, 1, 3, "L").rect(7, 18, 2, 1, "G");
    art.layer("lantern", angle, body);
    for (let frame = 0; frame < 9; frame++) {
      const flame = new Canvas(4, 6);
      if (frame) {
        // Odd frames stamp the flame's top row at y=0, even frames at y=1: a one-row bob that
        // reads as a flicker instead of a static flame once frames advance.
        flame.stamp(0, frame % 2 !== 0 ? 0 : 1, [".F..", ".FF.", "FLF.", "FLLF", ".FF."]);
      }
      art.layer("flame", angle, flame, {
        x: 6,
        y: 12,
        frame,
        min_pixels: frame ? 12 : 0,
        connected: Boolean(frame),
      });
    }
  }
  art.save(scene);
}
