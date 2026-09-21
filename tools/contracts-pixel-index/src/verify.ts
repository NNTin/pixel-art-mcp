#!/usr/bin/env node
/**
 * Verify pixel-art-mcp's understanding of pixel-index's custom-asset upload contract against a
 * live environment. Port of `contracts/pixel_index/verify.py`.
 *
 * Consumer-driven, read-only (see `checks.ts`'s module doc comment for why no authenticated
 * upload is attempted). A pass means "the zips this repo generates should still be
 * shape-compatible with what this environment's decode logic expects" -- not "this environment's
 * full API is unchanged."
 *
 * Run:
 *   node dist/verify.js --base-url https://pixel-index-api-staging.nntin.xyz
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CHECKS, type CheckContext, type CheckResult } from "./checks.js";

function utcNow(): string {
  // `datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")`: second precision,
  // trailing "Z" rather than "+00:00".
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function run(
  baseUrl: string,
  timeoutSeconds: number,
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const context: CheckContext = {};
  const timeoutMs = timeoutSeconds * 1000;
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    // Sequential by design (mirrors Python's list comprehension): later checks read `context`
    // fields earlier checks populate (e.g. `checkRoot`'s discovered commit).
    results.push(await check(baseUrl, context, timeoutMs));
  }
  const ok = !results.some((result) => result.status === "fail");
  return { ok, results };
}

export interface ResultDocument {
  readonly schema_version: 1;
  readonly environment: string;
  readonly base_url: string;
  readonly status: "pass" | "fail";
  readonly checked_at: string;
  readonly counts: { readonly pass: number; readonly fail: number; readonly skipped: number };
  readonly checks: readonly CheckResult[];
  readonly detail: string;
}

/** The stable, machine-readable result consumed by `generate-status-site.ts`. */
export function buildResultDocument(
  envName: string,
  baseUrl: string,
  ok: boolean,
  results: readonly CheckResult[],
): ResultDocument {
  const counts = {
    pass: results.filter((result) => result.status === "pass").length,
    fail: results.filter((result) => result.status === "fail").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
  const failed = results.filter((result) => result.status === "fail").map((result) => result.name);
  return {
    schema_version: 1,
    environment: envName,
    base_url: baseUrl,
    status: ok ? "pass" : "fail",
    checked_at: utcNow(),
    counts,
    checks: results,
    detail: ok ? "" : `Failed checks: ${failed.join(", ")}`,
  };
}

/** Atomically replace a placeholder result with the completed result. */
export function writeResultDocument(filePath: string, document: ResultDocument): void {
  const destination = path.resolve(filePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", "utf-8");
  renameSync(temporary, destination);
}

const STATUS_ICON: Record<CheckResult["status"], string> = {
  pass: "✅",
  fail: "❌",
  skipped: "⚠️",
};

export function formatReport(envName: string, results: readonly CheckResult[]): string {
  const lines = [
    `## pixel-index contract check — ${envName}`,
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
  ];
  for (const result of results) {
    const detail = (result.detail || "-").replaceAll("|", "\\|");
    lines.push(`| ${result.name} | ${STATUS_ICON[result.status]} ${result.status} | ${detail} |`);
  }
  return lines.join("\n");
}

interface Args {
  readonly baseUrl: string;
  readonly envName: string | undefined;
  readonly outputJson: string | undefined;
  readonly timeout: number;
}

function parseArgs(argv: readonly string[]): Args {
  let baseUrl: string | undefined;
  let envName: string | undefined;
  let outputJson: string | undefined;
  let timeout = 10.0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const [flag, inlineValue] = arg.includes("=") ? splitOnce(arg, "=") : [arg, undefined];
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`Missing value for ${flag}`);
      return value;
    };
    switch (flag) {
      case "--base-url":
        baseUrl = takeValue();
        break;
      case "--env-name":
        envName = takeValue();
        break;
      case "--output-json":
        outputJson = takeValue();
        break;
      case "--timeout":
        timeout = Number.parseFloat(takeValue());
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (baseUrl === undefined) {
    throw new Error("--base-url is required");
  }
  return { baseUrl, envName, outputJson, timeout };
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return [value.slice(0, index), value.slice(index + separator.length)];
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const envName = args.envName ?? args.baseUrl;
  const { ok, results } = await run(args.baseUrl, args.timeout);
  const document = buildResultDocument(envName, args.baseUrl, ok, results);

  if (args.outputJson) {
    writeResultDocument(args.outputJson, document);
  }

  const report = formatReport(envName, results);
  console.log(report);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, report + "\n\n", "utf-8");
  }

  return ok ? 0 : 1;
}

/** CLI entrypoint guard: only runs when this module is the process entrypoint
 * (`node dist/verify.js ...`), not when imported by tests. */
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
