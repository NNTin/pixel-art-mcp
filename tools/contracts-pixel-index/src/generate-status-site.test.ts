import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { badgeDocument, buildSnapshot, generateSite, loadResults } from "./generate-status-site.js";

function resultDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    environment: "staging",
    base_url: "https://staging.example.test",
    status: "pass",
    checked_at: "2024-01-01T00:00:00Z",
    counts: { pass: 6, fail: 0, skipped: 0 },
    checks: [{ name: "root", status: "pass", detail: "running commit abc" }],
    detail: "",
    ...overrides,
  };
}

describe("loadResults", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "contracts-pixel-index-status-site-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads and sorts by production-then-staging-then-alphabetical", () => {
    writeFileSync(path.join(dir, "staging.json"), JSON.stringify(resultDocument()));
    writeFileSync(
      path.join(dir, "production.json"),
      JSON.stringify(resultDocument({ environment: "production" })),
    );
    writeFileSync(
      path.join(dir, "canary.json"),
      JSON.stringify(resultDocument({ environment: "canary" })),
    );
    const results = loadResults(dir);
    expect(results.map((r) => r["environment"])).toEqual(["production", "staging", "canary"]);
  });

  it("marks a result unknown when its status is unrecognized", () => {
    writeFileSync(
      path.join(dir, "staging.json"),
      JSON.stringify(resultDocument({ status: "not-a-real-status" })),
    );
    const [result] = loadResults(dir);
    expect(result?.["status"]).toBe("unknown");
    expect(result?.["detail"]).toContain("Unrecognized contract result status");
  });

  it("marks a result unknown when checks is missing", () => {
    const document = resultDocument();
    delete document["checks"];
    writeFileSync(path.join(dir, "staging.json"), JSON.stringify(document));
    const [result] = loadResults(dir);
    expect(result?.["status"]).toBe("unknown");
    expect(result?.["checks"]).toEqual([]);
  });

  it("marks a result unknown when an individual check has an unrecognized status", () => {
    writeFileSync(
      path.join(dir, "staging.json"),
      JSON.stringify(resultDocument({ checks: [{ name: "root", status: "weird", detail: "" }] })),
    );
    const [result] = loadResults(dir);
    expect(result?.["status"]).toBe("unknown");
    const checks = result?.["checks"] as { status: string }[];
    expect(checks[0]?.status).toBe("unknown");
  });

  it("recomputes counts from the (possibly repaired) checks array", () => {
    writeFileSync(
      path.join(dir, "staging.json"),
      JSON.stringify(
        resultDocument({
          checks: [
            { name: "a", status: "pass", detail: "" },
            { name: "b", status: "fail", detail: "" },
            { name: "c", status: "skipped", detail: "" },
            { name: "d", status: "pass", detail: "" },
          ],
        }),
      ),
    );
    const [result] = loadResults(dir);
    expect(result?.["counts"]).toEqual({ pass: 2, fail: 1, skipped: 1 });
  });

  it("rejects a missing environment name", () => {
    const document = resultDocument();
    delete document["environment"];
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify(document));
    expect(() => loadResults(dir)).toThrow(/has no environment name/);
  });

  it("rejects an unsafe environment name", () => {
    writeFileSync(
      path.join(dir, "bad.json"),
      JSON.stringify(resultDocument({ environment: "../../etc" })),
    );
    expect(() => loadResults(dir)).toThrow(/unsafe environment name/);
  });

  it("rejects a duplicate environment", () => {
    writeFileSync(path.join(dir, "one.json"), JSON.stringify(resultDocument()));
    writeFileSync(path.join(dir, "two.json"), JSON.stringify(resultDocument()));
    expect(() => loadResults(dir)).toThrow(/Duplicate contract result for staging/);
  });

  it("rejects an empty results directory", () => {
    expect(() => loadResults(dir)).toThrow(/No contract result JSON files found/);
  });

  it("finds results in nested subdirectories, sorted by path", () => {
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFileSync(path.join(dir, "nested", "staging.json"), JSON.stringify(resultDocument()));
    const results = loadResults(dir);
    expect(results).toHaveLength(1);
  });
});

describe("buildSnapshot", () => {
  it("takes the worst status as overall (fail beats unknown beats pass)", () => {
    const results = [
      resultDocument({ environment: "production", status: "pass" }),
      resultDocument({ environment: "staging", status: "fail" }),
    ];
    const snapshot = buildSnapshot(results, {
      repository: "acme/pixel-art-mcp",
      branch: "develop",
      commit: "abc123",
      runId: 42,
      runUrl: "https://example.test/run/42",
      event: "push",
      generatedAt: new Date("2024-06-01T00:00:00Z"),
    });
    expect(snapshot["overall"]).toBe("fail");
    expect(snapshot["valid_until"]).toBe("2024-06-01T12:00:00Z");
    const environments = snapshot["environments"] as Record<string, unknown>;
    expect(Object.keys(environments).sort()).toEqual(["production", "staging"]);
    expect(snapshot["repository"]).toEqual({
      name: "acme/pixel-art-mcp",
      url: "https://github.com/acme/pixel-art-mcp",
    });
  });
});

describe("badgeDocument", () => {
  it("marks non-pass statuses as errors for Shields", () => {
    expect(badgeDocument("pixel-index staging", "pass")).toEqual({
      schemaVersion: 1,
      label: "pixel-index staging",
      message: "compatible",
      color: "brightgreen",
      cacheSeconds: 600,
    });
    expect(badgeDocument("pixel-index staging", "fail")).toMatchObject({
      message: "incompatible",
      color: "red",
      isError: true,
    });
  });
});

describe("generateSite", () => {
  let resultsDir: string;
  let outputDir: string;
  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), "contracts-pixel-index-site-"));
    resultsDir = path.join(root, "results");
    outputDir = path.join(root, "site");
    mkdirSync(resultsDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(path.dirname(resultsDir), { recursive: true, force: true });
  });

  it("writes the full JSON API + HTML dashboard from one environment result", () => {
    writeFileSync(path.join(resultsDir, "staging.json"), JSON.stringify(resultDocument()));

    const snapshot = generateSite(resultsDir, outputDir, {
      repository: "acme/pixel-art-mcp",
      branch: "develop",
      commit: "abcdef1234567890",
      runId: 7,
      runUrl: "https://example.test/run/7",
      event: "schedule",
      generatedAt: new Date("2024-06-01T00:00:00Z"),
    });
    expect(snapshot["overall"]).toBe("pass");

    for (const relativePath of [
      "status.json",
      "api/v1/status.json",
      "api/v1/environments/staging.json",
      "api/v1/badges/staging.json",
      "api/v1/badges/overall.json",
      "index.html",
    ]) {
      expect(existsSync(path.join(outputDir, relativePath))).toBe(true);
    }

    const status = JSON.parse(readFileSync(path.join(outputDir, "status.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(status["overall"]).toBe("pass");

    const html = readFileSync(path.join(outputDir, "index.html"), "utf-8");
    expect(html).toContain("pixel-index compatibility");
    expect(html).toContain("Staging");
    expect(html).not.toContain("Example asset gallery");
  });

  it("links the example gallery only when examples/index.html was already staged", () => {
    writeFileSync(
      path.join(resultsDir, "production.json"),
      JSON.stringify(resultDocument({ environment: "production" })),
    );
    mkdirSync(path.join(outputDir, "examples"), { recursive: true });
    writeFileSync(path.join(outputDir, "examples", "index.html"), "<html></html>");

    generateSite(resultsDir, outputDir, {
      repository: "acme/pixel-art-mcp",
      branch: "develop",
      commit: "abcdef1234567890",
      runId: 7,
      runUrl: "https://example.test/run/7",
      event: "schedule",
    });

    const html = readFileSync(path.join(outputDir, "index.html"), "utf-8");
    expect(html).toContain("Example asset gallery");
  });
});
