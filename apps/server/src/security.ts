/**
 * Port of two Starlette/FastAPI-level protections `src/pixel_art_mcp/app.py` wraps the whole
 * app in: `TrustedHostMiddleware` (Host header allowlist, `src/pixel_art_mcp/config.py`'s
 * `allowed_hosts`) and `RequestBoundary` (`src/pixel_art_mcp/api/middleware.py`: Origin header
 * allowlist + a pre-parse body-size cap).
 *
 * **Why one Fastify hook covers both `/mcp` and `/api/*` here, instead of using
 * `StreamableHTTPServerTransport`'s own `allowedHosts`/`allowedOrigins`/
 * `enableDnsRebindingProtection` options.** Those transport options exist and would reproduce
 * Python's `TransportSecuritySettings` almost directly, but the installed
 * `@modelcontextprotocol/sdk` (1.30.0) marks all three `@deprecated`, explicitly pointing
 * integrators at "external middleware" instead -- exactly this file. Python's own app already
 * has *two* layers doing conceptually the same check (`TransportSecuritySettings` at the FastMCP
 * layer, `TrustedHostMiddleware`/`RequestBoundary` at the ASGI-app layer, the latter wrapping
 * both `/mcp` and the plain REST routes); collapsing that into one Fastify `onRequest` hook
 * applied ahead of both surfaces keeps the guarantee ("a mismatched Host or disallowed Origin
 * never reaches a handler") while following the SDK's own current guidance, rather than wiring a
 * second, deprecated copy of the same check at the transport layer too.
 *
 * The body-size half of `RequestBoundary` is ported separately, via Fastify's own `bodyLimit`
 * constructor option (see `app.ts`) -- Fastify already rejects an oversized body with 413 before
 * handing control to any content-type parser, which is exactly what `RequestBoundary` earns by
 * hand-streaming the body itself ahead of Starlette's parsers.
 */

import type { FastifyInstance } from "fastify";

/** Matches Starlette's `TrustedHostMiddleware`: split the Host header on `:` and keep only the
 * hostname portion (this is a faithful port of that middleware's own naive split, including its
 * known misbehavior on bracketed IPv6 literals like `[::1]:8000` -- Python has the same quirk). */
function hostnameOf(hostHeader: string): string {
  return hostHeader.split(":")[0] ?? "";
}

function hostAllowed(hostHeader: string, allowedHosts: readonly string[]): boolean {
  const hostname = hostnameOf(hostHeader);
  return allowedHosts.some(
    (pattern) =>
      hostname === pattern || (pattern.startsWith("*") && hostname.endsWith(pattern.slice(1))),
  );
}

export interface SecurityOptions {
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}

/**
 * Registers the combined Host + Origin guard as the very first `onRequest` hook, so it runs
 * ahead of routing, the MCP transport, and multipart/body parsing -- matching the ASGI
 * middleware order in `app.py` (`TrustedHostMiddleware` wraps outside `RequestBoundary`, i.e.
 * the Host check runs first).
 */
export function registerSecurityHooks(app: FastifyInstance, options: SecurityOptions): void {
  app.addHook("onRequest", (request, reply, done) => {
    const hostHeader = request.headers.host ?? "";
    if (!hostAllowed(hostHeader, options.allowedHosts)) {
      reply.code(400).type("text/plain").send("Invalid host header");
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
      reply.code(403).send({ error: "Origin not allowed" });
      return;
    }
    done();
  });
}
