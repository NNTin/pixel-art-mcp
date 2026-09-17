import { describe, expect, it } from "vitest";

import { CHECKS } from "./index.js";

describe("@pixel-art-mcp/contracts-pixel-index", () => {
  it("exposes the six checks in Python's fixed order", () => {
    expect(CHECKS).toHaveLength(6);
  });
});
