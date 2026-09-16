import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@pixel-art-mcp/web", () => {
  it("loads", () => {
    expect(packageName).toBe("@pixel-art-mcp/web");
  });
});
