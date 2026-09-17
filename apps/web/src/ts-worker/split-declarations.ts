/**
 * Pure parsing helper, split out of `worker.ts` so it can be unit-tested under plain `vitest`
 * without needing a real Worker/`self` global (see this package's `.test.ts` for that coverage).
 * Splits `get_pixel_engine_reference`'s concatenated `type_declarations` string (built by
 * `apps/server/src/mcp/engine-reference.ts`'s `readTypeDeclarations`, one `// ===== file.d.ts
 * =====` marker per section) back into individual virtual files under `PIXEL_CORE_DIR`, so
 * `@pixel-art-mcp/pixel-core`'s own internal relative imports (`index.d.ts`'s `export { Canvas }
 * from "./canvas.js"`) resolve in the in-browser virtual filesystem exactly like they do against
 * the real compiled package.
 */

export const PIXEL_CORE_DIR = "/node_modules/@pixel-art-mcp/pixel-core";

const FILE_MARKER = /^\/\/ ===== (.+) =====$/m;

export function splitPixelCoreDeclarations(typeDeclarations: string): Map<string, string> {
  const files = new Map<string, string>();
  const sections = typeDeclarations.split(FILE_MARKER);
  // `String.split` on a capturing regex interleaves [prefix, capturedName, body, capturedName,
  // body, ...] -- section 0 (before the first marker) is always empty here, so start at 1.
  for (let i = 1; i < sections.length; i += 2) {
    const name = sections[i];
    const body = sections[i + 1];
    if (name !== undefined && body !== undefined) {
      files.set(`${PIXEL_CORE_DIR}/${name}`, body.trim());
    }
  }
  return files;
}
