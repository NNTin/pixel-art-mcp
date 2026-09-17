/**
 * Port of `Settings` in `src/pixel_art_mcp/config.py`: a `pydantic_settings.BaseSettings` that
 * loads `PIXEL_`-prefixed environment variables (and a `.env` file in the process's current
 * working directory) with typed defaults/bounds. `packages/service`'s `settings.ts` (Phase 6b)
 * deliberately only ports the *shape and defaults* `Service` itself needs -- this module is the
 * "later phase" that doc comment calls out: real env-var/`.env` loading, plus the HTTP-only
 * fields (`listen_host`, `allowed_hosts`, `allowed_origins`) Python's `Settings` also carries but
 * `Service` never reads.
 *
 * **Flagged approximation**: pydantic-settings parses a list-typed env var (`PIXEL_ALLOWED_HOSTS`
 * etc.) as JSON by default. This port accepts either JSON (`'["a","b"]'`) or a plain
 * comma-separated string (`'a,b'`) for convenience, since there is no single obviously-correct
 * behavior to copy without pulling in pydantic-settings' full parsing engine. The `.env` loader
 * below is similarly a minimal `KEY=VALUE` line parser, not a full dotenv implementation (no
 * quoting/multiline/export-prefix support) -- sufficient for this app's own `.env` usage.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Settings {
  data_dir: string;
  base_url: string;
  listen_host: string;
  script_timeout: number;
  render_timeout: number;
  max_upload_bytes: number;
  max_image_pixels: number;
  max_script_bytes: number;
  max_render_frames: number;
  max_sheet_pixels: number;
  max_pending_jobs: number;
  max_log_bytes: number;
  wait_for_job_max_timeout: number;
  wait_for_job_poll_interval: number;
  allowed_hosts: string[];
  allowed_origins: string[];
}

/** Verbatim port of `Settings`' `Field(default=...)` values, including the HTTP-only fields. */
export const DEFAULT_SETTINGS: Settings = {
  data_dir: "data",
  base_url: "http://localhost:8000",
  listen_host: "127.0.0.1",
  script_timeout: 120,
  render_timeout: 600,
  max_upload_bytes: 20 * 1024 * 1024,
  max_image_pixels: 40_000_000,
  max_script_bytes: 256 * 1024,
  max_render_frames: 256,
  max_sheet_pixels: 16_777_216,
  max_pending_jobs: 32,
  max_log_bytes: 64 * 1024,
  wait_for_job_max_timeout: 120,
  wait_for_job_poll_interval: 1.0,
  allowed_hosts: ["localhost", "127.0.0.1", "[::1]"],
  allowed_origins: ["http://localhost:8000", "http://127.0.0.1:8000"],
};

/** Bounds ported verbatim from each `Field(ge=..., le=...)`/`Field(gt=..., le=...)`. */
const BOUNDS: Partial<
  Record<keyof Settings, { readonly gt?: number; readonly ge?: number; readonly le: number }>
> = {
  script_timeout: { gt: 0, le: 3600 },
  render_timeout: { gt: 0, le: 86400 },
  max_upload_bytes: { ge: 1, le: Infinity },
  max_image_pixels: { ge: 1, le: Infinity },
  max_script_bytes: { ge: 1, le: Infinity },
  max_render_frames: { ge: 1, le: Infinity },
  max_sheet_pixels: { ge: 1, le: Infinity },
  max_pending_jobs: { ge: 1, le: Infinity },
  max_log_bytes: { ge: 1024, le: Infinity },
  wait_for_job_max_timeout: { gt: 0, le: 3600 },
  wait_for_job_poll_interval: { gt: 0, le: 60 },
};

/** Minimal `.env` loader: `KEY=VALUE` lines, `#`-prefixed comments, blank lines skipped. Does
 * not overwrite a variable that's already set in `process.env` (real env vars win over the
 * dotenv file, matching pydantic-settings' precedence). */
function loadDotEnvFile(cwd: string): Record<string, string> {
  const dotenvPath = path.join(cwd, ".env");
  if (!existsSync(dotenvPath)) return {};
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(dotenvPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parseStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // fall through to comma-separated parsing below
    }
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseNumber(key: keyof Settings, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`PIXEL_${key.toUpperCase()}: expected a number, got ${JSON.stringify(raw)}`);
  }
  const bounds = BOUNDS[key];
  if (bounds) {
    if (bounds.ge !== undefined && value < bounds.ge) {
      throw new Error(`PIXEL_${key.toUpperCase()}: must be >= ${String(bounds.ge)}`);
    }
    if (bounds.gt !== undefined && value <= bounds.gt) {
      throw new Error(`PIXEL_${key.toUpperCase()}: must be > ${String(bounds.gt)}`);
    }
    if (value > bounds.le) {
      throw new Error(`PIXEL_${key.toUpperCase()}: must be <= ${String(bounds.le)}`);
    }
  }
  return value;
}

const NUMERIC_KEYS: (keyof Settings)[] = [
  "script_timeout",
  "render_timeout",
  "max_upload_bytes",
  "max_image_pixels",
  "max_script_bytes",
  "max_render_frames",
  "max_sheet_pixels",
  "max_pending_jobs",
  "max_log_bytes",
  "wait_for_job_max_timeout",
  "wait_for_job_poll_interval",
];

const STRING_KEYS: (keyof Settings)[] = ["data_dir", "base_url", "listen_host"];
const ARRAY_KEYS: (keyof Settings)[] = ["allowed_hosts", "allowed_origins"];

/**
 * Loads `Settings` from `PIXEL_`-prefixed environment variables (env wins), falling back to a
 * `.env` file in `cwd`, falling back to `DEFAULT_SETTINGS`. Pass `overrides` for programmatic
 * construction (tests, `main()`'s own explicit args) -- highest precedence of all, mirroring
 * Python's `Settings(**kwargs)` constructor-argument precedence over both env and `.env`.
 */
export function loadSettings(
  overrides: Partial<Settings> = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Settings {
  const dotenv = loadDotEnvFile(cwd);
  const source = (key: string): string | undefined => env[`PIXEL_${key}`] ?? dotenv[`PIXEL_${key}`];

  // Built through an untyped bag (Settings' fields are a mix of string/string[]/number, so a
  // single generically-keyed assignment loop can't keep TS's per-key value type precise) and
  // cast back to `Settings` once every key has been assigned its correctly-typed value.
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of STRING_KEYS) {
    const raw = source(key.toUpperCase());
    if (raw !== undefined) settings[key] = raw;
  }
  for (const key of ARRAY_KEYS) {
    const raw = source(key.toUpperCase());
    if (raw !== undefined) settings[key] = parseStringArray(raw);
  }
  for (const key of NUMERIC_KEYS) {
    const raw = source(key.toUpperCase());
    if (raw !== undefined) settings[key] = parseNumber(key, raw);
  }
  return { ...(settings as unknown as Settings), ...overrides };
}
