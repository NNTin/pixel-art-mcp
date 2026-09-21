/**
 * Port of `src/pixel_art_mcp/api/routes.py`: the plain REST surface, backed by the same
 * `Service` the MCP tools (`../mcp/server.ts`) call into. Registered on the same Fastify
 * app/port as `/mcp` (see `../app.ts`), matching Python's `app.include_router(routes(service))`
 * mounted alongside the MCP ASGI sub-app.
 *
 * Route paths are unprefixed, exactly matching Python's `APIRouter()` (no `/api` prefix exists
 * in the Python source to preserve).
 *
 * Validation-error status codes: FastAPI turns a Pydantic body/query validation failure into a
 * `422`; this port reproduces that via a shared `setErrorHandler` in `../app.ts` that maps both
 * `fastify-type-provider-zod`'s schema-validation errors and a raw `ZodError` thrown by business
 * logic (e.g. `getAssetProfile`'s own `AssetSpecSchema.parse`) to `422`, and `DomainError` to its
 * own `httpStatus` -- see that file for the single place this mapping lives.
 */

import fs from "node:fs";

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AssetSpecSchema,
  DomainError,
  getAssetProfile,
  PixelDefinitionSchema,
} from "@pixel-art-mcp/schema";
import type { Service } from "@pixel-art-mcp/service";
import { z } from "zod";

import { nullableUuidParam, uuidParam } from "../mcp/params.js";

const CreateProjectBody = z.object({ name: z.string().min(1).max(120) });

const WritePixelArtBody = z.object({
  definition: PixelDefinitionSchema,
  expected_revision_id: nullableUuidParam(),
});

/** Querystring values always arrive as strings (unlike MCP's native JSON args), so REST's bounded
 * integer query params need `z.coerce.number()` ahead of the same `ge`/`le` bounds
 * `../mcp/params.ts`'s `boundedInt` applies for JSON-typed MCP tool arguments. */
function coercedBoundedInt(ge: number, le: number): z.ZodType<number> {
  return z.coerce.number().int().gte(ge).lte(le);
}

export function registerRestRoutes(app: FastifyInstance, service: Service): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/asset-profiles/:kind",
    {
      schema: {
        params: z.object({ kind: z.string() }),
        querystring: z.object({
          preset: z.string().optional(),
          ground_width: coercedBoundedInt(1, 16).optional(),
          ground_depth: coercedBoundedInt(1, 16).optional(),
          background_tiles: coercedBoundedInt(0, 31).optional(),
        }),
      },
    },
    (request) => {
      const { kind } = request.params;
      const { preset, ground_width, ground_depth, background_tiles } = request.query;
      return getAssetProfile(kind, preset ?? null, {
        groundWidth: ground_width,
        groundDepth: ground_depth,
        backgroundTiles: background_tiles,
      });
    },
  );

  typed.put(
    "/projects/:project_id/asset",
    {
      schema: {
        params: z.object({ project_id: uuidParam() }),
        body: AssetSpecSchema,
      },
    },
    (request) => service.configureAsset(request.params.project_id, request.body),
  );

  typed.post(
    "/projects/:project_id/asset/renders",
    {
      schema: {
        params: z.object({ project_id: uuidParam() }),
        querystring: z.object({ revision_id: nullableUuidParam().default(null) }),
      },
    },
    async (request, reply) => {
      const job = service.renderAsset(request.params.project_id, request.query.revision_id);
      await reply.code(202).send(job);
    },
  );

  typed.put(
    "/projects/:project_id/pixel-art",
    {
      schema: {
        params: z.object({ project_id: uuidParam() }),
        body: WritePixelArtBody,
      },
    },
    async (request, reply) => {
      const job = service.writePixelArt(
        request.params.project_id,
        request.body.definition,
        request.body.expected_revision_id,
      );
      await reply.code(202).send(job);
    },
  );

  typed.get(
    "/projects/:project_id/pixel-art",
    {
      schema: {
        params: z.object({ project_id: uuidParam() }),
        querystring: z.object({ revision_id: nullableUuidParam().default(null) }),
      },
    },
    (request) => service.getPixelArt(request.params.project_id, request.query.revision_id),
  );

  typed.get(
    "/jobs/:job_id/asset-inspection",
    { schema: { params: z.object({ job_id: uuidParam() }) } },
    (request) => service.inspectAsset(request.params.job_id),
  );

  typed.get("/health/live", () => ({ status: "ok" }));

  typed.get("/health/ready", async (_request, reply) => {
    const ready = service.workerReady;
    await reply.code(ready ? 200 : 503).send({ ready });
  });

  typed.post("/projects", { schema: { body: CreateProjectBody } }, async (request, reply) => {
    const project = service.createProject(request.body.name);
    await reply.code(201).send(project);
  });

  typed.get("/projects", () => service.listProjects());

  typed.get(
    "/projects/:project_id",
    { schema: { params: z.object({ project_id: uuidParam() }) } },
    (request) => service.getProject(request.params.project_id),
  );

  typed.post(
    "/projects/:project_id/references",
    { schema: { params: z.object({ project_id: uuidParam() }) } },
    async (request, reply) => {
      const projectId = request.params.project_id;
      // `service.store.project` throws `DomainError` (404) for an unknown project before any
      // upload streaming starts -- matches Python's early `service.store.project(...)` call.
      service.store.project(projectId);
      const file = await request.file({ limits: { fileSize: service.settings.max_upload_bytes } });
      if (!file) {
        throw new DomainError("A file part named 'file' is required", 422);
      }
      const data = await file.toBuffer();
      const reference = await service.addReference(projectId, data, file.filename || "image");
      await reply.code(201).send(reference);
    },
  );

  typed.get(
    "/artifacts/:artifact_id",
    { schema: { params: z.object({ artifact_id: uuidParam() }) } },
    async (request, reply) => {
      const artifactId = request.params.artifact_id;
      const artifact = service.artifact(artifactId);
      const filePath = service.artifactPath(artifactId);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${artifact.filename.replace(/"/g, "")}"`,
      );
      return reply.type(artifact.media_type).send(fs.createReadStream(filePath));
    },
  );
}
