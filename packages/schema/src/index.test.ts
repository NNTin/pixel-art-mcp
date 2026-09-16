import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@pixel-art-mcp/schema", () => {
  it("loads", () => {
    expect(packageName).toBe("@pixel-art-mcp/schema");
  });
});
