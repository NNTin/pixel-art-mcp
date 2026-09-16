/**
 * Public surface of `@pixel-art-mcp/engine`: the subprocess entrypoint a job actually runs (port
 * of `src/pixel_art_mcp/engine/runner.py` + `engine/render.py`; see `docs/typescript-rewrite.md`,
 * Phase 5a). `packages/imaging` (Phase 5b, not yet built) is where the real pixel
 * compositing/quantization/packaging pipeline lands -- this package only builds blank transparent
 * canvases plus the frame manifest imaging will composite onto.
 */

export { main, progress, runRender, runScript } from "./runner.js";
export type { EngineOperation, EngineRequest, ScriptResult } from "./runner.js";

export { nativeRender } from "./render.js";
export type { CameraView, FrameManifestEntry, NativeRenderOptions, RenderManifest } from "./render.js";

export { executeScript, ScriptCompileError, ScriptRuntimeError } from "./script-runtime.js";
export type { CompileDiagnostic } from "./script-runtime.js";
