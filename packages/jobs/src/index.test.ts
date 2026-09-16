import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@pixel-art-mcp/jobs", () => {
  it("loads", () => {
    expect(packageName).toBe("@pixel-art-mcp/jobs");
  });
});
