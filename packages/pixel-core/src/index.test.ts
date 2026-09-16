import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@pixel-art-mcp/pixel-core", () => {
  it("loads", () => {
    expect(packageName).toBe("@pixel-art-mcp/pixel-core");
  });
});
