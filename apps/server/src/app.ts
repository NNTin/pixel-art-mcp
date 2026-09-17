/**
 * Port of `src/pixel_art_mcp/app.py`'s `create_app`: builds one Fastify app serving both the MCP
 * Streamable HTTP transport (`POST`/`GET`/`DELETE /mcp`) and the plain REST surface
 * (`rest/routes.ts`) on the same port, matching Python's `app.include_router(routes(service));
 * app.mount("/", mcp_app)`.
 *
 * **Why a fresh `McpServer` + `StreamableHTTPServerTransport` per `/mcp` request.** This mirrors
 * the MCP TypeScript SDK's own documented stateless pattern (`examples/server/
 * simpleStatelessStreamableHttp.ts`: `sessionIdGenerator: undefined`, a new transport connected
 * to a new server for every request) rather than sharing one long-lived `McpServer` across
 * concurrent requests. The low-level `Server`/`Protocol` object a `McpServer` wraps holds a
 * single `_transport` reference; two concurrent `/mcp` requests calling `connect()` on the *same*
 * shared server would race on that reference and could route a response through the wrong
 * request's transport. A fresh, cheap (`registerTool` just builds closures, no I/O) `McpServer`
 * per request sidesteps that entirely and reproduces Python's `stateless_http=True` (a fresh
 * session per request, no cross-request session state) more literally than the deprecated
 * `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection` transport options would anyway
 * (see `security.ts`'s doc comment for that half of the port).
 *
 * **DNS-rebinding / origin protection** is `registerSecurityHooks` (`security.ts`), applied
 * before both surfaces. **Oversized-body rejection** (Python's `RequestBoundary` hand-streaming
 * the body ahead of any parser) is Fastify's own `bodyLimit` constructor option, computed with
 * the exact formula `app.py` uses. **Validation-error mapping** (Pydantic's automatic `422`,
 * `DomainError`'s own `status`) is one shared `setErrorHandler` below.
 */

import fastifyMultipart from "@fastify/multipart";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DomainError } from "@pixel-art-mcp/schema";
import type { Service } from "@pixel-art-mcp/service";
import Fastify, { type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";

import { createMcpServer } from "./mcp/server.js";
import { registerRestRoutes } from "./rest/routes.js";
import { registerSecurityHooks } from "./security.js";
import type { Settings } from "./settings.js";

/** Verbatim port of `app.py`'s `max_bytes` formula for `RequestBoundary`'s pre-parse body cap:
 * base64-inflated upload bound (`4 * ceil(max_upload_bytes / 3)`) plus the script size limit
 * plus 65536 bytes of slack for JSON-RPC/multipart framing overhead. */
function computeBodyLimit(settings: Settings): number {
  return 4 * Math.ceil((settings.max_upload_bytes + 2) / 3) + settings.max_script_bytes + 65536;
}

function isFastifyErrorLike(error: unknown): error is { statusCode?: number; message: string } {
  return typeof error === "object" && error !== null && "message" in error;
}

export function buildApp(service: Service, settings: Settings): FastifyInstance {
  const app = Fastify({
    bodyLimit: computeBodyLimit(settings),
  }).withTypeProvider<ZodTypeProvider>();

  registerSecurityHooks(app, {
    allowedHosts: settings.allowed_hosts,
    allowedOrigins: settings.allowed_origins,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      void reply.code(error.httpStatus).send({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.code(422).send({ error: error.message });
      return;
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      void reply.code(422).send({ error: "Validation error", issues: error.validation });
      return;
    }
    const statusCode =
      isFastifyErrorLike(error) && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
      void reply.code(statusCode).send({ error: "Internal server error" });
      return;
    }
    void reply
      .code(statusCode)
      .send({ error: isFastifyErrorLike(error) ? error.message : "Bad request" });
  });

  void app.register(fastifyMultipart, {
    limits: { fileSize: settings.max_upload_bytes },
  });

  registerRestRoutes(app, service);

  app.all("/mcp", async (request, reply) => {
    reply.hijack();
    try {
      const mcpServer: McpServer = createMcpServer(service);
      // `enableJsonResponse: true` matches Python's `FastMCP(..., json_response=True)`: a plain
      // JSON body per request instead of an SSE stream (still stateless: `sessionIdGenerator:
      // undefined`, per this file's top comment).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      reply.raw.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (error) {
      request.log.error(error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  return app;
}
