/**
 * Port of `create_app`'s lifespan wiring in `src/pixel_art_mcp/app.py`: constructs a real
 * `Service` (`@pixel-art-mcp/service`), a real `Worker` (`@pixel-art-mcp/jobs`) driven by the
 * real `createJobExecutor(service)` (the same engine-subprocess + imaging-export executor Phase
 * 6b proved end-to-end), attaches them to each other, and builds the Fastify app
 * (`app.ts`) on top. `start()`/`stop()` mirror Python's `async with lifespan(app)`: start the
 * worker (lock acquisition, crash recovery, scratch-dir wipe) before serving, stop it (drain the
 * in-flight job, release the lock) and close the store after.
 */

import { Worker } from "@pixel-art-mcp/jobs";
import { createJobExecutor, Service } from "@pixel-art-mcp/service";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { loadSettings, type Settings } from "./settings.js";

export interface Runtime {
  readonly app: FastifyInstance;
  readonly service: Service;
  readonly worker: Worker;
  readonly settings: Settings;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Builds the whole app without starting it (worker not yet started, no port bound) -- the TS
 * equivalent of Python's `create_app(settings)` (construction only; `main()`/the ASGI lifespan
 * is what actually calls `worker.start()`). Tests that want a fully running stack should call
 * `start()` before issuing requests and `stop()` in teardown, matching Python's
 * `app.router.lifespan_context(app)` test fixture pattern.
 */
export function createRuntime(overrides: Partial<Settings> = {}): Runtime {
  const settings = loadSettings(overrides);
  const service = new Service({
    data_dir: settings.data_dir,
    base_url: settings.base_url,
    script_timeout: settings.script_timeout,
    render_timeout: settings.render_timeout,
    max_upload_bytes: settings.max_upload_bytes,
    max_image_pixels: settings.max_image_pixels,
    max_script_bytes: settings.max_script_bytes,
    max_render_frames: settings.max_render_frames,
    max_sheet_pixels: settings.max_sheet_pixels,
    max_pending_jobs: settings.max_pending_jobs,
    max_log_bytes: settings.max_log_bytes,
    wait_for_job_max_timeout: settings.wait_for_job_max_timeout,
    wait_for_job_poll_interval: settings.wait_for_job_poll_interval,
  });
  const worker = new Worker({ store: service.store, execute: createJobExecutor(service) });
  service.attachWorker(worker);
  const app = buildApp(service, settings);

  return {
    app,
    service,
    worker,
    settings,
    async start() {
      await worker.start();
    },
    async stop() {
      await worker.stop();
      service.store.close();
    },
  };
}
