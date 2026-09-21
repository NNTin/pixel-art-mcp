/**
 * Port of `Settings` in `src/pixel_art_mcp/config.py`. Python's `Settings` is a
 * `pydantic_settings.BaseSettings` that loads from `PIXEL_`-prefixed environment variables and a
 * `.env` file -- that loading belongs to `apps/server` (Phase 7, not built yet: this package has
 * no business reading `process.env` or parsing `.env` files itself), so this module only ports
 * the *shape* and *default values* `Service` itself needs. **Flagged gap**: env-var/`.env`
 * loading (`PIXEL_SCRIPT_TIMEOUT=...` etc.) is not implemented anywhere yet -- a later phase must
 * either build that in `apps/server` and pass the resolved `ServiceSettings` into `Service`'s
 * constructor, or add it here. `allowed_hosts`/`allowed_origins`/`listen_host` are omitted
 * entirely: they're HTTP-server concerns `Service` itself never reads (only `mcp/server.py`'s
 * DNS-rebinding middleware does in the Python source), so they belong with `apps/server` too.
 */

/** Everything `Service` reads off Python's `Settings`, minus the HTTP-server-only fields above. */
export interface ServiceSettings {
  /** Where `Store`'s SQLite file and every project's scratch/artifact tree live. */
  data_dir: string;
  base_url: string;
  /** Seconds. */
  script_timeout: number;
  /** Seconds. */
  render_timeout: number;
  max_upload_bytes: number;
  max_image_pixels: number;
  max_script_bytes: number;
  max_render_frames: number;
  max_sheet_pixels: number;
  max_pending_jobs: number;
  max_log_bytes: number;
  /** Seconds. */
  wait_for_job_max_timeout: number;
  /** Seconds. */
  wait_for_job_poll_interval: number;
}

/** Verbatim port of `Settings`' `Field(default=...)` values. */
export const DEFAULT_SERVICE_SETTINGS: Omit<ServiceSettings, "data_dir"> = {
  base_url: "http://localhost:8000",
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
};
