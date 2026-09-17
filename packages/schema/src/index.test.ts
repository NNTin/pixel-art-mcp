import { describe, expect, it } from "vitest";
import { AUTHORING_VERSION, AssetSpecSchema } from "./index.js";

describe("@pixel-art-mcp/schema", () => {
  it("loads and re-exports the authoring/model surface", () => {
    expect(AUTHORING_VERSION).toBe(1);
    const spec = AssetSpecSchema.parse({ kind: "furniture", name: "Lamp", asset_id: "LAMP" });
    expect(spec.kind).toBe("furniture");
  });
});
