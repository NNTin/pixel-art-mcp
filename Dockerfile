# Phase 11a: rewritten for the pure-Node TS stack (drops the Python/uv base entirely). Builds and
# runs `apps/server` (a Fastify app that also serves `apps/web`'s static Vite build, per Phase 9,
# from the same origin -- see `apps/server/src/app.ts`'s top comment). Same base OS family
# (Debian bookworm) and exact-version pin discipline as the Python image it replaces.
#
# Multi-stage: `build` installs the full pnpm workspace (dev+prod deps), builds every package via
# `pnpm -r build` (`tsc -b` project references resolve each `@pixel-art-mcp/*` package's compiled
# `dist/`, which real runtime module resolution -- e.g. `packages/service/src/job-executor.ts`
# and `apps/server/src/mcp/engine-reference.ts` both `createRequire(...).resolve(...)` an
# installed package to find its compiled entrypoint/`.d.ts` output -- depends on being present),
# deletes `tools/*` (CI-only: `contracts-pixel-index`, `generate-examples`) and `apps/web/e2e`
# (Playwright fixtures) -- never imported by the running server -- then reinstalls with
# `pnpm install --prod --frozen-lockfile` to drop every devDependency (typescript, eslint, vitest,
# playwright, tsx, ...) workspace-wide.
#
# **`pnpm install --prod`, not `pnpm prune --prod`.** Tried `pnpm prune --prod` first; verified
# (outside Docker, which wasn't available in this phase's sandbox -- see this phase's report) that
# it silently wipes every workspace-linked `node_modules/@pixel-art-mcp/*` symlink repo-wide, not
# just devDependencies, because it resolves what to keep against the *workspace root's own*
# package.json (which depends on none of `@pixel-art-mcp/*` -- those are `apps/server`'s
# dependencies) rather than each workspace member's. The result started but crashed immediately
# on the first real import: `Cannot find package '@pixel-art-mcp/jobs'`. A prod-mode
# `pnpm install` is workspace-recursive by default and rebuilds every member's own symlinks
# correctly -- confirmed by actually starting the server on the result and driving a real
# `tools/list` call plus a full render through it (see this phase's report).
#
# The pnpm workspace's own symlinked `node_modules` layout (`node_modules/@pixel-art-mcp/schema`
# -> `../../packages/schema`, one per workspace member) is why the final stage copies the whole
# `/app` tree rather than trying to hand-pick files: every workspace package's `dist/` +
# `package.json` has to stay at its real repo-relative path for both that symlink structure and
# `apps/server/src/app.ts`'s own relative `../../web/dist` lookup for `apps/web`'s static build to
# keep resolving correctly.
FROM node:22.23.1-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
# Non-interactive `pnpm install`/`prune`-family commands refuse certain removals without a TTY
# (no TTY inside a `docker build` RUN step); `CI=true` is pnpm's documented way to say "yes,
# proceed non-interactively" -- discovered by actually running this exact sequence outside Docker
# during this phase's verification, not by inspection alone.
ENV CI=true
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN rm -rf tools/contracts-pixel-index tools/generate-examples apps/web/e2e
RUN pnpm install --prod --frozen-lockfile

FROM node:22.23.1-bookworm-slim

# ca-certificates: outbound HTTPS reference-image fetches (`packages/service/src/references.ts`'s
# SSRF-safe fetch) need a real CA trust store to validate the remote server's certificate, same as
# the Python image's own `ca-certificates` install (undici, like httpx, doesn't bundle one).
#
# procps: `packages/jobs/src/process.ts`'s `stopProcess` (the `tree-kill`-based port of Python's
# `os.killpg`) shells out to the `ps` binary on Linux to walk a job's process tree, even after
# the child has already exited normally -- `os.killpg` needed no external binary since it's a
# syscall, but `tree-kill` does. Without this, every job (including ones that succeed) crashes
# the whole server with an unhandled `spawn ps ENOENT` error the moment its cleanup runs,
# discovered via a real CI Docker e2e run failing on the very first example.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates procps \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PIXEL_DATA_DIR=/data \
    PIXEL_LISTEN_HOST=0.0.0.0

WORKDIR /app
RUN useradd --uid 10001 --create-home app && mkdir /data && chown app:app /data
COPY --from=build --chown=app:app /app /app

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health/ready', { signal: AbortSignal.timeout(3000) }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "/app/apps/server/dist/index.js"]
