import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { splitMultiClipZip } from "./pixel-index-packaging.js";

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("splitMultiClipZip", () => {
  it("returns [] when the archive has zero or one manifest.json", () => {
    const single = zipSync({
      "RAIN_BARREL_EMPTY/manifest.json": textBytes(
        JSON.stringify({ id: "RAIN_BARREL_EMPTY", name: "Empty" }),
      ),
      "RAIN_BARREL_EMPTY/sprite.png": textBytes("fake-png"),
    });
    expect(splitMultiClipZip(single)).toEqual([]);
  });

  it("splits a multi-clip archive into one standalone zip per manifest.json, preserving paths", () => {
    const multi = zipSync({
      "RAIN_BARREL_EMPTY/manifest.json": textBytes(
        JSON.stringify({ id: "RAIN_BARREL_EMPTY", name: "Empty" }),
      ),
      "RAIN_BARREL_EMPTY/sprite.png": textBytes("empty-sprite"),
      "RAIN_BARREL_FULL/manifest.json": textBytes(
        JSON.stringify({ id: "RAIN_BARREL_FULL", name: "Full" }),
      ),
      "RAIN_BARREL_FULL/sprite.png": textBytes("full-sprite"),
    });

    const clips = splitMultiClipZip(multi);
    expect(clips.map((c) => c.assetId).sort()).toEqual(["RAIN_BARREL_EMPTY", "RAIN_BARREL_FULL"]);

    const empty = clips.find((c) => c.assetId === "RAIN_BARREL_EMPTY");
    if (!empty) throw new Error("expected a RAIN_BARREL_EMPTY clip");
    expect(empty.name).toBe("Empty");
    const emptyArchive = unzipSync(empty.data);
    expect(Object.keys(emptyArchive).sort()).toEqual([
      "RAIN_BARREL_EMPTY/manifest.json",
      "RAIN_BARREL_EMPTY/sprite.png",
    ]);
    expect(new TextDecoder().decode(emptyArchive["RAIN_BARREL_EMPTY/sprite.png"])).toBe(
      "empty-sprite",
    );

    const full = clips.find((c) => c.assetId === "RAIN_BARREL_FULL");
    if (!full) throw new Error("expected a RAIN_BARREL_FULL clip");
    const fullArchive = unzipSync(full.data);
    expect(Object.keys(fullArchive).sort()).toEqual([
      "RAIN_BARREL_FULL/manifest.json",
      "RAIN_BARREL_FULL/sprite.png",
    ]);
  });
});
