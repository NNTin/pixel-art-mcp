import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@pixel-art-mcp/contracts-pixel-index", () => {
  it("loads", () => {
    expect(packageName).toBe("@pixel-art-mcp/contracts-pixel-index");
  });
});
