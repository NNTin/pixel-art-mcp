import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

// `apps/web`'s build output is served by `apps/server` from the same Fastify origin as `/mcp`
// and the REST/`/api` routes (see `apps/server/src/app.ts`'s `webDistDir`/`@fastify/static`
// registration) -- no CORS configuration is needed there. `server.proxy` below only matters for
// `vite dev` (an operator iterating on the UI against an already-running `apps/server` on
// :8000), not for the production build this phase's automated verification actually exercises.
export default defineConfig({
  plugins: [react()],
  server: {
    // Allows this pnpm workspace's `node_modules/typescript/lib/*.d.ts` glob import
    // (`src/ts-worker/lib-files.ts`) to be served by the dev server even though it resolves
    // outside `apps/web` itself (a real monorepo path, not an arbitrary filesystem escape).
    fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/mcp": "http://127.0.0.1:8000",
      "/projects": "http://127.0.0.1:8000",
      "/artifacts": "http://127.0.0.1:8000",
      "/asset-profiles": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
