import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";

/**
 * A barrel drawn top-down 3/4 (dominant mouth/opening, compressed staves below), matching
 * pixel-agents' own camera convention instead of a flat front elevation. Explicit feature
 * budgets throughout.
 *
 * Ported from `rain_barrel.py`, including the mouth-contrast/waterline history captured in its
 * comments -- carried over verbatim below since it explains *why* the drawing is shaped the way
 * it is, not just what pixels are where.
 */
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
  const body = Canvas.fromRows([
    "..DDDDDDDDDDDD..",
    "...DHHHHHHHHD...",
    "..DHHHHHHHHHHD..",
    "..DHHHHHHHHHHD..",
    "...DDDDDDDDDD...",
    "...DMMMMMMMMD...",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "..DHWWWWWWWSSD..",
    "...DWWWWWWWSD...",
    "...DDDDDDDDDD...",
    "...DDDDDDDDDD...",
    ".....DDDDDD.....",
  ]);
  const tap = Canvas.fromRows([".GGG..", "..G...", ".GGGG.", "....G.", "....G."]);
  const surround = Canvas.fromRows(["DDDDD.", ".DDD..", "DDDDDD", ".DDDDD", "...DDD", "....D."]);
  // The body is 20 rows tall (was 16), for a taller, more cylindrical barrel rather than one
  // squashed short by an oversized mouth. BODY_TOP keeps the body's bottom at the same y=29 it
  // always had (10 + 20 - 1).
  const BODY_TOP = 10;

  type Point = readonly [number, number];
  const mouthKey = (x: number, y: number): string => `${String(x)},${String(y)}`;

  // The mouth is narrower than the body (8 wide at its band, vs. the body's 12) and sits low
  // enough to overlap the body's own H highlight collar (rows 1-3 of `body`, immediately below
  // BODY_TOP): that collar is wider than the mouth, so it shows through on both sides as a
  // wood-toned rim framing the opening -- the same technique the pre-#22 design used to make the
  // mouth read as a hole in the barrel rather than a flat patch sitting on top of it. Without
  // this overlap the mouth had no visible frame and the faucet/gauge, offset from a stale
  // pre-shrink BODY_TOP, sat far lower on the body than intended.
  const MOUTH: Point[] = [];
  for (let x = 2; x <= 8; x++) for (let y = 0; y <= 1; y++) MOUTH.push([x, y]);
  for (let x = 1; x <= 9; x++) for (let y = 2; y <= 4; y++) MOUTH.push([x, y]);
  for (let x = 2; x <= 8; x++) for (let y = 5; y <= 6; y++) MOUTH.push([x, y]);
  const mouthSet = new Set(MOUTH.map(([x, y]) => mouthKey(x, y)));
  const DELTAS: readonly Point[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const MOUTH_RIM = new Set(
    MOUTH.filter(([x, y]) =>
      DELTAS.some(([dx, dy]) => !mouthSet.has(mouthKey(x + dx, y + dy))),
    ).map(([x, y]) => mouthKey(x, y)),
  );

  for (const angle of [0, 90, 180, 270]) {
    art.layer("barrel", angle, body, { y: BODY_TOP });
    // Controls sit in the mid-band of staves, not crammed against the bottom rim -- these are
    // absolute canvas offsets, independent of BODY_TOP.
    if (angle === 0) {
      art.layer("tap surround", angle, surround, { x: 2, y: 19 });
      art.layer("faucet", angle, tap, { x: 2, y: 19, min_pixels: 10, connected: true });
    } else if (angle === 90 || angle === 270) {
      const side = Canvas.fromRows(["GG.", ".G.", ".GG", "..G"]);
      art.layer("side faucet", angle, angle === 90 ? side : side.mirrored(), {
        x: angle === 90 ? 12 : 1,
        y: 20,
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
        // A wide mouth seen from above: a 2-row taper, a 3-row wide band, then another 2-row
        // taper. Sits low enough (y=6, not y=2) to overlap the body's own H highlight collar,
        // which is wider than the mouth and frames it in wood on both sides.
        //
        // Rows below `waterline` are wet (C); above it, dry (D). Partial and full must show
        // different water lines -- filling the whole mouth for both looked identical and hid
        // which state was which. The rim (M) takes priority over both: it borders the part of
        // the mouth exposed against open background (y<4) regardless of whether what's inside is
        // dry or full to the brim, so a "full" mouth still reads as a rimmed opening instead of a
        // borderless water patch merging straight into the background.
        const waterline = [7, 3, 0][level];
        const opening = new Canvas(12, 7);
        for (const [x, y] of MOUTH) {
          const key = mouthKey(x, y);
          let color: string;
          if (MOUTH_RIM.has(key) && y < 4) color = "M";
          else if (y < waterline) color = "D";
          else color = "C";
          opening.rect(x, y, 1, 1, color);
        }
        if (level) {
          const glintY = Math.max(waterline, 0);
          opening.rect(2 + (phase % 2), glintY, 5, Math.min(2, 7 - glintY), "L");
        }
        art.layer("opening", angle, opening, { x: 2, y: 6, frame, min_pixels: 45, connected: true });
        if (angle === 0) {
          const gauge = new Canvas(4, 7).rect(0, 0, 4, 7, "D").rect(1, 1, 2, 5, "M");
          const fill = [0, 2, 5][level];
          if (fill) {
            gauge.rect(1, 6 - fill, 2, fill, "C").rect(1, 6 - fill, 2, 1, "L");
          }
          art.layer("level gauge", angle, gauge, {
            x: 9,
            y: 18,
            frame,
            min_pixels: 28,
            connected: true,
          });
        }
        if (phase) {
          const rain = new Canvas(10, 8);
          for (const [x, shift] of [
            [0, 0],
            [4, 3],
            [8, 5],
          ] as const) {
            const y = (phase + shift) % 6;
            rain.rect(x, y, 1, 2, "L");
          }
          art.layer("rain", angle, rain, { x: 3, y: 2, frame });
        }
      }
    }
  }
  art.save(scene);
}
