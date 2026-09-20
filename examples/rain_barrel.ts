import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";

/** A 14×24 barrel on the consumer's 16×32 grid, with a shallow wooden rim and tall gauge. */
export default function main(scene: Scene): void {
  const art = new PixelArt(
    {
      D: "#293039",
      S: "#805437",
      W: "#b78752",
      H: "#dfb87b",
      M: "#71818b",
      G: "#f3cf65",
      C: "#358fa6",
      L: "#9ddacb",
    },
    { 0: [16, 32], 90: [16, 32], 180: [16, 32], 270: [16, 32] },
  );
  // The opening sits inside this wooden rim. Both metal bands stay continuous and
  // separate from the controls, with a short stave seam suggesting the wood construction.
  const body = Canvas.fromRows([
    "....DDDDDDDD....",
    "..DHHHHHHHHHHD..",
    ".DHHDDDDDDDDHHD.",
    ".DHDDDDDDDDDDSD.",
    ".DHHDDDDDDDDHHD.",
    "..DDDDDDDDDDDD..",
    "..DMMMMMMMMMMD..",
    "..DDDDDDDDDDDD..",
    ".DHWWWWSWWWWSSD.",
    ".DHWWWWSWWWWSSD.",
    ".DHWWWWSWWWWSSD.",
    ".DHWWWWWWWWWSSD.",
    ".DHWWWWWWWWWSSD.",
    ".DHWWWWWWWWWSSD.",
    ".DHWWWWWWWWWSSD.",
    ".DHWWWWWWWWWSSD.",
    ".DHWWWWWWWWWSSD.",
    ".DHWWWWWWWWWSSD.",
    ".DHWWWWWWWWWSSD.",
    "..DWWWWWWWWWSD..",
    "..DDDDDDDDDDDD..",
    "..DMMMMMMMMMMD..",
    "..DSSSSSSSSSSD..",
    "....DDDDDDDD....",
  ]);
  const tap = Canvas.fromRows([".GGG..", "..G...", ".GGGG.", "....G.", "....G."]);
  const surround = Canvas.fromRows([
    ".DDD..",
    "DDDDD.",
    ".DDDD.",
    "DDDDDD",
    ".DDDDD",
    "...DDD",
    "....D.",
  ]);

  for (const angle of [0, 90, 180, 270]) {
    art.layer("barrel", angle, body, { y: 6 });
    if (angle === 0) {
      art.layer("tap surround", angle, surround, { x: 2, y: 17 });
      art.layer("faucet", angle, tap, { x: 2, y: 18, min_pixels: 10, connected: true });
    } else if (angle === 90 || angle === 270) {
      const side = Canvas.fromRows(["GG.", ".G.", ".GG", "..G"]);
      art.layer("side faucet", angle, angle === 90 ? side : side.mirrored(), {
        x: angle === 90 ? 12 : 1,
        y: 19,
        min_pixels: 6,
        connected: true,
      });
    } else {
      const seams = new Canvas(5, 7).rect(0, 0, 1, 7, "S").rect(4, 0, 1, 7, "S");
      art.layer("rear staves", angle, seams, { x: 6, y: 18 });
    }
    for (let level = 0; level < 3; level++) {
      for (let phase = 0; phase < 9; phase++) {
        const frame = level * 10 + phase;
        // The reference shows the same shallow surface for both wet states; the gauge
        // carries the fill level. Animate only its glint, keeping the rim fully visible.
        const water = level === 0 ? "D" : "C";
        const opening = new Canvas(10, 3)
          .rect(1, 0, 8, 1, water)
          .rect(0, 1, 10, 1, water)
          .rect(1, 2, 8, 1, water);
        if (level) opening.rect(1 + (phase % 2), 0, 3, 1, "L");
        art.layer("opening", angle, opening, {
          x: 3,
          y: 8,
          frame,
          min_pixels: 26,
          connected: true,
        });
        if (angle === 0) {
          const gauge = new Canvas(4, 10).rect(0, 0, 4, 10, "D").rect(1, 1, 2, 8, "M");
          const fill = [0, 4, 8][level];
          if (fill) {
            gauge.rect(1, 9 - fill, 2, fill, "C").rect(1, 9 - fill, 2, 1, "L");
          }
          art.layer("level gauge", angle, gauge, {
            x: 10,
            y: 15,
            frame,
            min_pixels: 40,
            connected: true,
          });
        }
        if (phase) {
          // Keep falling drops in the five rows above the barrel so they never erase its rim.
          const rain = new Canvas(10, 5);
          for (const [x, shift] of [
            [0, 0],
            [4, 3],
            [8, 5],
          ] as const) {
            const y = (phase + shift) % 4;
            rain.rect(x, y, 1, 2, "L");
          }
          art.layer("rain", angle, rain, { x: 3, y: 1, frame });
        }
      }
    }
  }
  art.save(scene);
}
