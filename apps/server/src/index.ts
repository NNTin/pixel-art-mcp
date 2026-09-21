/**
 * Port of `src/pixel_art_mcp/app.py`'s `main()`: the process entrypoint. Native development is
 * loopback-only (`settings.listen_host`, default `127.0.0.1`); Docker overrides the bind address
 * via `PIXEL_LISTEN_HOST`, matching Python's own comment on this exact line. Port `8000` is
 * hardcoded in the Python source (not settings-driven) and stays hardcoded here for the same
 * reason -- `PIXEL_PORT` is deliberately not a real Python setting, so it isn't one here either.
 */

import { pathToFileURL } from "node:url";

import { createRuntime, type Runtime } from "./runtime.js";

export { createRuntime, type Runtime };
export { buildApp } from "./app.js";
export { loadSettings, DEFAULT_SETTINGS, type Settings } from "./settings.js";

const PORT = 8000;

export async function main(): Promise<Runtime> {
  const runtime = createRuntime();
  await runtime.start();
  await runtime.app.listen({ port: PORT, host: runtime.settings.listen_host });
  runtime.app.log.info(
    `Pixel Art MCP server listening on http://${runtime.settings.listen_host}:${String(PORT)}`,
  );
  const shutdown = (): void => {
    void runtime.app
      .close()
      .then(() => runtime.stop())
      .finally(() => {
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return runtime;
}

// Mirrors Python's `if __name__ == "__main__": main()` -- only run when this module is the
// process entrypoint (`node dist/index.js`), not when imported (e.g. by tests).
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
