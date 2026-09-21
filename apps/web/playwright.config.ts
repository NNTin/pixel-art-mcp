/**
 * Headless end-to-end proof for Phase 9's two-pane editor/render flow (`docs/typescript-
 * rewrite.md`'s Phase 9 verification step: "Playwright e2e -- edit -> run -> see updated
 * render"). Drives a real, built `apps/web` served by a real, built `apps/server` instance
 * (`webServer` below), exercising the entire stack this phase added: the `/api/*` routes, the
 * real `Service`/`Worker`/engine subprocess/imaging pipeline underneath them, and the actual
 * CodeMirror + TS-worker + SSE-driven UI -- not a mocked backend.
 *
 * `apps/server`'s listen port is hardcoded to `8000` (see `apps/server/src/index.ts`'s own doc
 * comment on why `PIXEL_PORT` is deliberately not a real setting), so this config targets that
 * port directly rather than picking an ephemeral one.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = 8000;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: "retain-on-failure",
  },
  webServer: {
    // Both `apps/server` and `apps/web` must already be built (`pnpm -r build`) before this
    // runs -- see the repo root's verification checklist. A fresh `PIXEL_DATA_DIR` per run keeps
    // this test isolated from any real local `data/` directory.
    command: "node ../server/dist/index.js",
    cwd: import.meta.dirname,
    env: {
      PIXEL_DATA_DIR: `${import.meta.dirname}/.e2e-data`,
      PIXEL_LISTEN_HOST: "127.0.0.1",
    },
    url: `http://127.0.0.1:${String(PORT)}/health/live`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
