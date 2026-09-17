#!/usr/bin/env node
/**
 * Generate the current pixel-index contract status site and JSON API. Port of
 * `contracts/pixel_index/generate_status_site.py`.
 *
 * The input directory contains one structured result per environment, produced by `verify.ts`.
 * The output is a self-contained GitHub Pages artifact: it keeps no history and exposes the same
 * snapshot as accessible HTML, a versioned JSON API, and Shields-compatible badge documents.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RESULT_STATUSES = new Set(["pass", "fail", "unknown"]);
const CHECK_STATUSES = new Set(["pass", "fail", "skipped"]);
const STATUS_PRIORITY: Record<string, number> = { fail: 0, unknown: 1, pass: 2 };
const ENVIRONMENT_PRIORITY: Record<string, number> = { production: 0, staging: 1 };

interface StatusPresentation {
  readonly icon: string;
  readonly label: string;
  readonly badge: string;
  readonly color: string;
}

const STATUS_PRESENTATION: Record<string, StatusPresentation> = {
  pass: { icon: "✓", label: "Compatible", badge: "compatible", color: "brightgreen" },
  fail: { icon: "×", label: "Incompatible", badge: "incompatible", color: "red" },
  unknown: { icon: "?", label: "Unknown", badge: "unknown", color: "lightgrey" },
};
/** Same object as `STATUS_PRESENTATION["unknown"]`, duplicated as a statically-typed constant so
 * every lookup fallback (`STATUS_PRESENTATION[status] ?? ...`) never needs a non-null assertion
 * -- the map is typed with a general `string` index signature (any status the loaded JSON might
 * carry), so TypeScript can't know the literal `"unknown"` key is present. */
const FALLBACK_STATUS_PRESENTATION: StatusPresentation = {
  icon: "?",
  label: "Unknown",
  badge: "unknown",
  color: "lightgrey",
};
function presentationFor(status: string): StatusPresentation {
  return STATUS_PRESENTATION[status] ?? FALLBACK_STATUS_PRESENTATION;
}

const CHECK_PRESENTATION: Record<string, readonly [string, string]> = {
  pass: ["✓", "Pass"],
  fail: ["×", "Fail"],
  skipped: ["!", "Skipped"],
  unknown: ["?", "Unknown"],
};
const FALLBACK_CHECK_PRESENTATION: readonly [string, string] = ["?", "Unknown"];
function checkPresentationFor(status: string): readonly [string, string] {
  return CHECK_PRESENTATION[status] ?? FALLBACK_CHECK_PRESENTATION;
}

function utcNow(): Date {
  return new Date();
}

/** `datetime.isoformat(timespec="seconds").replace("+00:00", "Z")`. */
function isoformat(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** Minimal `repr()` for error text -- this generator's own error strings aren't contract-tested,
 * just diagnostic, so an approximation (not byte-identical to Python's `repr`) is fine. */
function pyRepr(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "string") return `'${value.replaceAll("'", "\\'")}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "<unrepresentable>";
  }
}

/** Reads a `Record<string, unknown>` field as a string, or `fallback` if it isn't one -- avoids
 * ever calling `String()`/template-interpolating an `unknown` value that might carry a
 * non-primitive (and therefore `[object Object]`-stringifying) type. */
function stringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function listJsonFilesSorted(resultsDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        found.push(full);
      }
    }
  };
  if (existsSync(resultsDir) && statSync(resultsDir).isDirectory()) walk(resultsDir);
  return found.sort();
}

/** Validates and repairs one loaded result document in place, exactly mirroring
 * `generate_status_site.py::load_results`'s per-file defaulting rules, then returns it. */
function normalizeResult(raw: unknown, sourcePath: string): Record<string, unknown> {
  const record: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};

  const environment = record["environment"];
  if (typeof environment !== "string" || environment === "") {
    throw new Error(`Contract result ${sourcePath} has no environment name`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(environment)) {
    throw new Error(
      `Contract result ${sourcePath} has an unsafe environment name: ${pyRepr(environment)}`,
    );
  }

  const status = record["status"];
  if (!RESULT_STATUSES.has(typeof status === "string" ? status : "")) {
    record["status"] = "unknown";
    record["detail"] = `Unrecognized contract result status: ${pyRepr(status)}`;
  }

  const rawChecks = record["checks"];
  if (!Array.isArray(rawChecks)) {
    record["checks"] = [];
    record["status"] = "unknown";
    record["detail"] = "Contract result did not contain check results.";
  } else {
    for (const rawCheck of rawChecks) {
      const check = isRecord(rawCheck) ? rawCheck : undefined;
      const checkStatus = check ? check["status"] : undefined;
      if (!CHECK_STATUSES.has(typeof checkStatus === "string" ? checkStatus : "")) {
        if (check) check["status"] = "unknown";
        record["status"] = "unknown";
        record["detail"] = "Contract result contained an unrecognized check status.";
      }
    }
  }

  const checks = asArray(record["checks"]);
  record["counts"] = {
    pass: checks.filter((check) => isRecord(check) && check["status"] === "pass").length,
    fail: checks.filter((check) => isRecord(check) && check["status"] === "fail").length,
    skipped: checks.filter((check) => isRecord(check) && check["status"] === "skipped").length,
  };

  return record;
}

export function loadResults(resultsDir: string): Record<string, unknown>[] {
  const byEnvironment = new Map<string, Record<string, unknown>>();
  for (const filePath of listJsonFilesSorted(resultsDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read contract result ${filePath}: ${message}`);
    }
    const result = normalizeResult(parsed, filePath);
    const environment = result["environment"] as string;
    if (byEnvironment.has(environment)) {
      throw new Error(`Duplicate contract result for ${environment}`);
    }
    byEnvironment.set(environment, result);
  }

  if (byEnvironment.size === 0) {
    throw new Error(`No contract result JSON files found below ${resultsDir}`);
  }

  return [...byEnvironment.values()].sort((a, b) => {
    const nameA = a["environment"] as string;
    const nameB = b["environment"] as string;
    const priorityA = ENVIRONMENT_PRIORITY[nameA] ?? 100;
    const priorityB = ENVIRONMENT_PRIORITY[nameB] ?? 100;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });
}

export interface BuildSnapshotOptions {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly runId: number;
  readonly runUrl: string;
  readonly event: string;
  readonly generatedAt?: Date;
  readonly validForHours?: number;
}

export function buildSnapshot(
  results: readonly Record<string, unknown>[],
  options: BuildSnapshotOptions,
): Record<string, unknown> {
  const generatedAt = options.generatedAt ?? utcNow();
  const validForHours = options.validForHours ?? 12;

  let overall = results[0] ? stringField(results[0], "status", "unknown") : "unknown";
  for (const result of results) {
    const status = stringField(result, "status", "unknown");
    if ((STATUS_PRIORITY[status] ?? 1) < (STATUS_PRIORITY[overall] ?? 1)) overall = status;
  }

  const repositoryUrl = `https://github.com/${options.repository}`;
  const environments: Record<string, Record<string, unknown>> = {};
  for (const result of results) environments[result["environment"] as string] = result;

  const validUntil = new Date(generatedAt.getTime() + validForHours * 60 * 60 * 1000);

  return {
    schema_version: 1,
    service: "pixel-index-contract",
    repository: { name: options.repository, url: repositoryUrl },
    default_branch: {
      name: options.branch,
      commit: options.commit,
      commit_url: `${repositoryUrl}/commit/${options.commit}`,
    },
    generated_at: isoformat(generatedAt),
    valid_until: isoformat(validUntil),
    run: { id: options.runId, url: options.runUrl, event: options.event },
    overall,
    environments,
  };
}

export function badgeDocument(label: string, status: string): Record<string, unknown> {
  const presentation = presentationFor(status);
  const document: Record<string, unknown> = {
    schemaVersion: 1,
    label,
    message: presentation.badge,
    color: presentation.color,
    cacheSeconds: 600,
  };
  if (status !== "pass") document["isError"] = true;
  return document;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function renderEnvironmentCards(environments: readonly Record<string, unknown>[]): string {
  return environments
    .map((environment) => {
      const name = String(environment["environment"]);
      const status = String(environment["status"]);
      const presentation = presentationFor(status);
      const counts = isRecord(environment["counts"])
        ? environment["counts"]
        : { pass: 0, fail: 0, skipped: 0 };
      const checkedAt = environment["checked_at"];
      const checked =
        typeof checkedAt === "string" && checkedAt
          ? `<time datetime="${escapeHtml(checkedAt)}">${escapeHtml(checkedAt)}</time>`
          : "Not completed";
      const baseUrl = typeof environment["base_url"] === "string" ? environment["base_url"] : "";
      const detail = environment["detail"];
      return `
            <article class="environment-card status-${escapeHtml(status)}">
              <div class="card-heading">
                <div>
                  <p class="eyebrow">Environment</p>
                  <h2>${escapeHtml(titleCase(name))}</h2>
                </div>
                <span class="status-pill"><span aria-hidden="true">${presentation.icon}</span> ${presentation.label}</span>
              </div>
              <p class="counts"><strong>${escapeHtml(counts["pass"])}</strong> passed · <strong>${escapeHtml(counts["fail"])}</strong> failed · <strong>${escapeHtml(counts["skipped"])}</strong> skipped</p>
              <dl>
                <div><dt>Checked</dt><dd>${checked}</dd></div>
                <div><dt>Target</dt><dd><a href="${escapeHtml(baseUrl)}">${escapeHtml(baseUrl || "Unknown")}</a></dd></div>
              </dl>
              ${detail ? `<p class="environment-detail">${escapeHtml(detail)}</p>` : ""}
            </article>
            `;
    })
    .join("\n");
}

/** Python's `str.title()` for the environment-name headings ("production" -> "Production"). */
function titleCase(value: string): string {
  return value.replace(
    /[A-Za-z]+/g,
    (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
  );
}

function checkNames(environments: readonly Record<string, unknown>[]): string[] {
  const names: string[] = [];
  for (const environment of environments) {
    for (const check of asArray(environment["checks"])) {
      const name = isRecord(check) ? stringField(check, "name", "unknown") : "unknown";
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

function renderCheckTable(environments: readonly Record<string, unknown>[]): string {
  const names = checkNames(environments);
  const headers = environments
    .map(
      (environment) =>
        `<th scope="col">${escapeHtml(titleCase(stringField(environment, "environment", "")))}</th>`,
    )
    .join("");

  const rows = names.map((name) => {
    const cells = environments
      .map((environment) => {
        const check = asArray(environment["checks"]).find(
          (item) => isRecord(item) && item["name"] === name,
        );
        const status =
          check && isRecord(check) ? stringField(check, "status", "unknown") : "unknown";
        const [icon, label] = checkPresentationFor(status);
        const detail =
          check && isRecord(check)
            ? stringField(check, "detail", "")
            : "No check result was produced.";
        const detailHtml = detail ? `<span class="check-detail">${escapeHtml(detail)}</span>` : "";
        return `<td class="check-status status-${escapeHtml(status)}"><span class="check-label"><span aria-hidden="true">${icon}</span> ${label}</span>${detailHtml}</td>`;
      })
      .join("");
    return `<tr><th scope="row"><code>${escapeHtml(name)}</code></th>${cells}</tr>`;
  });

  if (rows.length === 0) {
    rows.push(
      `<tr><td colspan="${String(environments.length + 1)}" class="empty">No check results were produced.</td></tr>`,
    );
  }

  return `
      <div class="table-scroll">
        <table>
          <thead><tr><th scope="col">Check</th>${headers}</tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;
}

function renderHtml(
  snapshot: Record<string, unknown>,
  options: { readonly examplesGalleryAvailable: boolean },
): string {
  const environments = Object.values(snapshot["environments"] as Record<string, unknown>) as Record<
    string,
    unknown
  >[];
  const overallStatus = stringField(snapshot, "overall", "unknown");
  const overall = presentationFor(overallStatus);
  const branch = snapshot["default_branch"] as Record<string, unknown>;
  const run = snapshot["run"] as Record<string, unknown>;
  const shortCommit = String(branch["commit"]).slice(0, 7);
  const repository = snapshot["repository"] as Record<string, unknown>;
  const generatedAt = String(snapshot["generated_at"]);
  const validUntil = String(snapshot["valid_until"]);

  const galleryLink = options.examplesGalleryAvailable
    ? '<p class="lede"><a href="examples/index.html">Example asset gallery</a> — every ' +
      "example in examples/asset-specs.json, generated through the real MCP rendering " +
      "pipeline.</p>"
    : "";

  const apiEnvironmentLinks = environments
    .map(
      (environment) =>
        `<a href="api/v1/environments/${encodeURIComponent(String(environment["environment"]))}.json">${escapeHtml(titleCase(String(environment["environment"])))}</a>`,
    )
    .join("");
  const apiBadgeLinks = environments
    .map(
      (environment) =>
        `<a href="api/v1/badges/${encodeURIComponent(String(environment["environment"]))}.json">${escapeHtml(titleCase(String(environment["environment"])))} badge endpoint</a>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Current pixel-art-mcp compatibility with the pixel-index production and staging APIs.">
  <title>pixel-index contract status</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4f6f8; --surface: #fff; --text: #172033; --muted: #657087; --line: #dce1e8; --pass: #137333; --pass-bg: #e6f4ea; --fail: #b3261e; --fail-bg: #fce8e6; --unknown: #5f6368; --unknown-bg: #eef0f2; --skipped: #8a5d00; --skipped-bg: #fff4ce; --link: #0969da; --shadow: 0 12px 32px rgba(30, 42, 62, .08); }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0 72px; }
    a { color: var(--link); }
    header { margin-bottom: 30px; }
    h1, h2 { line-height: 1.15; margin: 0; }
    h1 { font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -.04em; max-width: 760px; }
    h2 { font-size: 1.3rem; }
    .eyebrow { color: var(--muted); font-size: .74rem; font-weight: 750; letter-spacing: .12em; margin: 0 0 7px; text-transform: uppercase; }
    .lede { color: var(--muted); font-size: 1.05rem; max-width: 700px; }
    .overall { align-items: center; background: var(--surface); border: 1px solid var(--line); border-left: 6px solid var(--unknown); border-radius: 16px; box-shadow: var(--shadow); display: flex; gap: 18px; justify-content: space-between; margin: 28px 0; padding: 20px 22px; }
    .overall.status-pass { border-left-color: var(--pass); } .overall.status-fail { border-left-color: var(--fail); }
    .overall strong { display: block; font-size: 1.15rem; } .overall p { color: var(--muted); margin: 2px 0 0; }
    .status-pill, .check-label { align-items: center; border-radius: 999px; display: inline-flex; font-size: .85rem; font-weight: 720; gap: 6px; padding: 5px 10px; white-space: nowrap; }
    .status-pass .status-pill, .check-status.status-pass .check-label { background: var(--pass-bg); color: var(--pass); }
    .status-fail .status-pill, .check-status.status-fail .check-label { background: var(--fail-bg); color: var(--fail); }
    .status-unknown .status-pill, .check-status.status-unknown .check-label { background: var(--unknown-bg); color: var(--unknown); }
    .check-status.status-skipped .check-label { background: var(--skipped-bg); color: var(--skipped); }
    .environment-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); margin-bottom: 36px; }
    .environment-card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 22px; }
    .card-heading { align-items: flex-start; display: flex; gap: 15px; justify-content: space-between; }
    .counts { color: var(--muted); } .counts strong { color: var(--text); }
    dl { margin: 20px 0 0; } dl div { border-top: 1px solid var(--line); display: grid; gap: 16px; grid-template-columns: 72px 1fr; padding: 10px 0; }
    dt { color: var(--muted); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .environment-detail { background: var(--unknown-bg); border-radius: 8px; margin: 12px 0 0; padding: 10px 12px; }
    section { margin-top: 34px; } section > h2 { margin-bottom: 14px; }
    .table-scroll { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); overflow-x: auto; }
    table { border-collapse: collapse; min-width: 680px; width: 100%; } th, td { border-bottom: 1px solid var(--line); padding: 14px 16px; text-align: left; vertical-align: top; } thead th { color: var(--muted); font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; } tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
    code { background: var(--unknown-bg); border-radius: 5px; padding: 2px 5px; }
    .check-detail { color: var(--muted); display: block; font-size: .84rem; margin-top: 7px; max-width: 360px; overflow-wrap: anywhere; }
    .metadata { color: var(--muted); display: flex; flex-wrap: wrap; gap: 8px 18px; list-style: none; padding: 0; }
    .api-links { display: flex; flex-wrap: wrap; gap: 10px; } .api-links a { background: var(--surface); border: 1px solid var(--line); border-radius: 9px; padding: 8px 11px; text-decoration: none; }
    .stale-banner { background: var(--skipped-bg); border: 1px solid #dfbd69; border-radius: 10px; color: #604400; display: none; margin: 18px 0; padding: 12px 15px; } body.is-stale .stale-banner { display: block; }
    footer { border-top: 1px solid var(--line); color: var(--muted); margin-top: 42px; padding-top: 22px; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --surface: #161b22; --text: #e6edf3; --muted: #9da7b3; --line: #30363d; --pass: #56d364; --pass-bg: #173b23; --fail: #ff7b72; --fail-bg: #4c1f21; --unknown: #b1bac4; --unknown-bg: #262c34; --skipped: #e3b341; --skipped-bg: #3b2e12; --link: #58a6ff; --shadow: none; } .stale-banner { color: #f1d488; } }
    @media (max-width: 600px) { main { padding-top: 32px; } .overall { align-items: flex-start; flex-direction: column; } .card-heading { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body data-generated-at="${escapeHtml(generatedAt)}" data-valid-until="${escapeHtml(validUntil)}">
  <main>
    <header>
      <p class="eyebrow">pixel-art-mcp · consumer contract</p>
      <h1>pixel-index compatibility</h1>
      <p class="lede">The latest read-only contract check from this repository's default branch against
      pixel-index's production and staging APIs — do the custom-asset zips pixel-art-mcp generates still
      match what those environments accept? No authenticated upload is performed; see
      <a href="https://github.com/${escapeHtml(repository["name"])}/blob/${escapeHtml(branch["name"])}/docs/contract-testing.md">docs/contract-testing.md</a>.</p>
      ${galleryLink}
      <div class="stale-banner" role="alert"><strong>This result is stale.</strong> The expected refresh window has passed; follow the workflow link before relying on it.</div>
    </header>

    <div class="overall status-${escapeHtml(overallStatus)}">
      <div><strong>Overall status</strong><p id="freshness">Generated ${escapeHtml(generatedAt)}</p></div>
      <span class="status-pill"><span aria-hidden="true">${overall.icon}</span> ${overall.label}</span>
    </div>

    <div class="environment-grid">
      ${renderEnvironmentCards(environments)}
    </div>

    <section aria-labelledby="check-heading">
      <h2 id="check-heading">Check results</h2>
      ${renderCheckTable(environments)}
    </section>

    <section aria-labelledby="run-heading">
      <h2 id="run-heading">Result metadata</h2>
      <ul class="metadata">
        <li>Branch <strong>${escapeHtml(branch["name"])}</strong></li>
        <li>Commit <a href="${escapeHtml(branch["commit_url"])}"><code>${escapeHtml(shortCommit)}</code></a></li>
        <li>Workflow <a href="${escapeHtml(run["url"])}">run ${escapeHtml(run["id"])}</a></li>
        <li>Event <strong>${escapeHtml(run["event"])}</strong></li>
        <li>Valid until <time datetime="${escapeHtml(validUntil)}">${escapeHtml(validUntil)}</time></li>
      </ul>
    </section>

    <section aria-labelledby="api-heading">
      <h2 id="api-heading">JSON API</h2>
      <div class="api-links">
        <a href="api/v1/status.json">Complete status</a>
        ${apiEnvironmentLinks}
        <a href="api/v1/badges/overall.json">Overall badge endpoint</a>
        ${apiBadgeLinks}
      </div>
    </section>

    <footer>This is a consumer-driven compatibility check for pixel-art-mcp, not a complete pixel-index availability monitor.</footer>
  </main>
  <script>
    (() => {
      const body = document.body;
      const generatedAt = new Date(body.dataset.generatedAt);
      const validUntil = new Date(body.dataset.validUntil);
      const freshness = document.getElementById('freshness');
      const update = () => {
        const minutes = Math.max(0, Math.floor((Date.now() - generatedAt.getTime()) / 60000));
        const age = minutes < 1 ? 'just now' : minutes < 60 ? \`\${minutes} minute\${minutes === 1 ? '' : 's'} ago\` : \`\${Math.floor(minutes / 60)} hour\${Math.floor(minutes / 60) === 1 ? '' : 's'} ago\`;
        freshness.textContent = \`Generated \${age}\`;
        body.classList.toggle('is-stale', Date.now() > validUntil.getTime());
      };
      update();
      window.setInterval(update, 60000);
    })();
  </script>
</body>
</html>
`;
}

export interface GenerateSiteOptions {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly runId: number;
  readonly runUrl: string;
  readonly event: string;
  readonly validForHours?: number;
  readonly generatedAt?: Date;
}

export function generateSite(
  resultsDir: string,
  outputDir: string,
  options: GenerateSiteOptions,
): Record<string, unknown> {
  const results = loadResults(resultsDir);
  const snapshot = buildSnapshot(results, {
    repository: options.repository,
    branch: options.branch,
    commit: options.commit,
    runId: options.runId,
    runUrl: options.runUrl,
    event: options.event,
    generatedAt: options.generatedAt,
    validForHours: options.validForHours,
  });

  mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, "status.json"), snapshot);
  writeJson(path.join(outputDir, "api", "v1", "status.json"), snapshot);

  for (const environment of results) {
    const name = environment["environment"] as string;
    const environmentDocument = {
      schema_version: snapshot["schema_version"],
      generated_at: snapshot["generated_at"],
      valid_until: snapshot["valid_until"],
      default_branch: snapshot["default_branch"],
      run: snapshot["run"],
      environment,
    };
    writeJson(
      path.join(outputDir, "api", "v1", "environments", `${name}.json`),
      environmentDocument,
    );
    writeJson(
      path.join(outputDir, "api", "v1", "badges", `${name}.json`),
      badgeDocument(`pixel-index ${name}`, String(environment["status"])),
    );
  }

  writeJson(
    path.join(outputDir, "api", "v1", "badges", "overall.json"),
    badgeDocument("pixel-index contract", String(snapshot["overall"])),
  );

  const examplesGalleryAvailable = existsSync(path.join(outputDir, "examples", "index.html"));
  writeFileSync(
    path.join(outputDir, "index.html"),
    renderHtml(snapshot, { examplesGalleryAvailable }),
    "utf-8",
  );
  return snapshot;
}

interface CliArgs {
  readonly resultsDir: string;
  readonly outputDir: string;
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly runId: number;
  readonly runUrl: string;
  readonly event: string;
  readonly validForHours: number;
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const [flag, inlineValue] = arg.includes("=") ? splitOnce(arg, "=") : [arg, undefined];
    let value = inlineValue;
    if (value === undefined) {
      i += 1;
      value = argv[i];
      if (value === undefined) throw new Error(`Missing value for ${flag}`);
    }
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  const validForHoursRaw = values.get("--valid-for-hours");
  return {
    resultsDir: required("--results-dir"),
    outputDir: required("--output-dir"),
    repository: required("--repository"),
    branch: required("--branch"),
    commit: required("--commit"),
    runId: Number.parseInt(required("--run-id"), 10),
    runUrl: required("--run-url"),
    event: required("--event"),
    validForHours: validForHoursRaw !== undefined ? Number.parseFloat(validForHoursRaw) : 12,
  };
}

export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const snapshot = generateSite(path.resolve(args.resultsDir), path.resolve(args.outputDir), {
    repository: args.repository,
    branch: args.branch,
    commit: args.commit,
    runId: args.runId,
    runUrl: args.runUrl,
    event: args.event,
    validForHours: args.validForHours,
  });
  console.log(`Generated ${args.outputDir} with overall status: ${String(snapshot["overall"])}`);
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
