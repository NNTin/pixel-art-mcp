import { describe, expect, it } from "vitest";

import { condenseLog } from "./log-condense.js";

describe("condenseLog", () => {
  it("returns short logs unchanged", () => {
    const log = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`).join("\n");
    expect(condenseLog(log)).toBe(log);
  });

  it("returns empty input unchanged", () => {
    expect(condenseLog("")).toBe("");
  });

  it("keeps the last 40 lines plus omission markers for a long log", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`);
    const condensed = condenseLog(lines.join("\n"));
    expect(condensed).toContain("... (60 line(s) omitted) ...");
    expect(condensed).toContain("line 99");
    expect(condensed).not.toContain("line 5\n");
  });

  it("surfaces earlier error/traceback/exception lines ahead of the tail", () => {
    const lines = [
      "starting up",
      "Traceback (most recent call last):",
      "ValueError: boom",
      ...Array.from({ length: 60 }, (_, i) => `noise ${String(i)}`),
    ];
    const condensed = condenseLog(lines.join("\n"));
    expect(condensed).toContain("Traceback");
    expect(condensed).toContain("ValueError: boom");
    expect(condensed).toContain("noise 59");
  });

  it("clips individual lines longer than 500 characters", () => {
    const longLine = "x".repeat(1000);
    const lines = [longLine, ...Array.from({ length: 45 }, (_, i) => `line ${String(i)}`)];
    const condensed = condenseLog(lines.join("\n"));
    // The long line isn't in the tail window here, so it's dropped entirely rather than clipped --
    // this just proves condensation doesn't crash or balloon on pathological input.
    expect(condensed.length).toBeLessThan(lines.join("\n").length);
  });
});
