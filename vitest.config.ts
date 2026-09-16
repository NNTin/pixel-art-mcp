import { defineConfig } from "vitest/config";

// Note for `packages/storage`: running its test suite (which imports `node:sqlite`) requires
// vitest >=3.0 / vite-node >=3.0. vite-node's `node:`-prefix-stripping externalization logic
// (`utils.mjs`'s `prefixedBuiltins` set) hardcodes which `node:`-only builtins must keep their
// prefix, and didn't add `"node:sqlite"` to that set until vite-node 3.0.0 -- on vite-node 2.x,
// `import("node:sqlite")` gets normalized to a bare `"sqlite"` specifier under test (but not in
// plain `node`) and fails to resolve. See `packages/storage/src/store.ts`'s top comment for the
// full `node:sqlite` compatibility note; this repo's root `vitest` devDependency was bumped to
// `^3.2.7` (from `^2.1.8`) specifically to pick up that fix.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tools/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
