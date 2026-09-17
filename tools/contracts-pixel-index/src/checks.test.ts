/**
 * Exercises every check against a real local HTTP server (not a mocked `fetch`) so the actual
 * request/response handling -- status codes, JSON parsing, 404-as-skipped special cases -- is
 * proven, matching `contracts/pixel_index/tests`' own style of hitting a real environment.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  CHECKS,
  checkAssetsList,
  checkManifestSchemaCharacter,
  checkManifestSchemaFurniture,
  checkManifestSchemaPet,
  checkOpenapiQueryShape,
  checkRoot,
  type CheckContext,
} from "./checks.js";

const TIMEOUT_MS = 5000;

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startServer(handler: Handler): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** A minimal JSON Schema 2020-12 furniture-manifest schema: only checks that a `members` array,
 * an `id`, and a `name` are present -- lenient enough to pass real fixture manifests, strict
 * enough to fail an obviously incompatible one when a test overrides `required`. */
function furnitureSchema(extraRequired: string[] = []): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["id", "name", "type", "members", ...extraRequired],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      type: { const: "group" },
      members: { type: "array" },
    },
  };
}

function minimalIdNameSchema(extraRequired: string[] = []): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["id", "name", ...extraRequired],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
    },
  };
}

describe("CHECKS", () => {
  it("runs in the fixed Python order", () => {
    expect(CHECKS).toEqual([
      checkRoot,
      checkOpenapiQueryShape,
      checkManifestSchemaFurniture,
      checkManifestSchemaCharacter,
      checkManifestSchemaPet,
      checkAssetsList,
    ]);
  });
});

describe("checkRoot", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.close();
  });

  it("passes and records the commit in context when 'commit' is present", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/") sendJson(res, 200, { commit: "abc1234" });
      else sendJson(res, 404, {});
    });
    const context: CheckContext = {};
    const result = await checkRoot(server.baseUrl, context, TIMEOUT_MS);
    expect(result).toEqual({ name: "root", status: "pass", detail: "running commit abc1234" });
    expect(context.commit).toBe("abc1234");
  });

  it("fails when the response has no 'commit' field", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, 200, {});
    });
    const result = await checkRoot(server.baseUrl, {}, TIMEOUT_MS);
    expect(result).toEqual({
      name: "root",
      status: "fail",
      detail: "GET / response has no 'commit' field",
    });
  });

  it("fails on a non-2xx response", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const result = await checkRoot(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.name).toBe("root");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("GET / failed");
  });

  it("fails when the server is unreachable", async () => {
    const result = await checkRoot("http://127.0.0.1:1", {}, TIMEOUT_MS);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("GET / failed");
  });
});

describe("checkOpenapiQueryShape", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.close();
  });

  it("passes when POST /api/v1/assets has no stale query params", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, 200, {
        paths: { "/api/v1/assets": { post: { parameters: [{ name: "limit" }] } } },
      });
    });
    const result = await checkOpenapiQueryShape(server.baseUrl, {}, TIMEOUT_MS);
    expect(result).toEqual({
      name: "openapi-query-shape",
      status: "pass",
      detail: "no assetKind/category/name query params",
    });
  });

  it("fails when a stale query param is still declared", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, 200, {
        paths: {
          "/api/v1/assets": { post: { parameters: [{ name: "assetKind" }, { name: "category" }] } },
        },
      });
    });
    const result = await checkOpenapiQueryShape(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("['assetKind', 'category']");
  });

  it("is skipped when POST /api/v1/assets isn't in the spec yet", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, 200, { paths: {} });
    });
    const result = await checkOpenapiQueryShape(server.baseUrl, {}, TIMEOUT_MS);
    expect(result).toEqual({
      name: "openapi-query-shape",
      status: "skipped",
      detail: "POST /api/v1/assets is not deployed to this environment yet",
    });
  });
});

describe("manifest schema checks", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.close();
  });

  it("checkManifestSchemaFurniture passes against a real generated furniture manifest", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/api/v1/assets/schema/furniture") sendJson(res, 200, furnitureSchema());
      else sendJson(res, 404, {});
    });
    const result = await checkManifestSchemaFurniture(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.status).toBe("pass");
    expect(result.name).toBe("manifest-schema-furniture");
  });

  it("checkManifestSchemaFurniture fails when the live schema requires a field the real export doesn't emit", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/api/v1/assets/schema/furniture") {
        sendJson(res, 200, furnitureSchema(["thisFieldDoesNotExist"]));
      } else sendJson(res, 404, {});
    });
    const result = await checkManifestSchemaFurniture(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("thisFieldDoesNotExist");
  });

  it("checkManifestSchemaFurniture is skipped on a 404 (no schema endpoint yet)", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, 404, {});
    });
    const result = await checkManifestSchemaFurniture(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.status).toBe("skipped");
  });

  it("checkManifestSchemaCharacter passes against a real generated character manifest", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/api/v1/assets/schema/character") sendJson(res, 200, minimalIdNameSchema());
      else sendJson(res, 404, {});
    });
    const result = await checkManifestSchemaCharacter(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.status).toBe("pass");
  });

  it("checkManifestSchemaPet passes against a real generated pet manifest", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/api/v1/assets/schema/pet") sendJson(res, 200, minimalIdNameSchema());
      else sendJson(res, 404, {});
    });
    const result = await checkManifestSchemaPet(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.status).toBe("pass");
  });

  it("includes the discovered commit in the pass detail", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/api/v1/assets/schema/pet") sendJson(res, 200, minimalIdNameSchema());
      else sendJson(res, 404, {});
    });
    const context: CheckContext = { commit: "deadbee" };
    const result = await checkManifestSchemaPet(server.baseUrl, context, TIMEOUT_MS);
    expect(result.detail).toBe("validated live schema (commit deadbee)");
  });
});

describe("checkAssetsList", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.close();
  });

  it("passes when every returned assetKind is allowed", async () => {
    server = await startServer((req, res) => {
      expect(req.url).toBe("/api/v1/assets?limit=1");
      sendJson(res, 200, { assets: [{ assetKind: "furniture" }], total: 5 });
    });
    const result = await checkAssetsList(server.baseUrl, {}, TIMEOUT_MS);
    expect(result).toEqual({
      name: "assets-list",
      status: "pass",
      detail: "1 asset(s) checked, of 5 total",
    });
  });

  it("fails on an unexpected assetKind", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, 200, { assets: [{ assetKind: "vehicle" }], total: 1 });
    });
    const result = await checkAssetsList(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("vehicle");
  });

  it("is skipped when the route doesn't exist yet", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, 404, {});
    });
    const result = await checkAssetsList(server.baseUrl, {}, TIMEOUT_MS);
    expect(result.status).toBe("skipped");
  });
});

describe("integration: run all six checks against one server", () => {
  it("produces six ordered results, with the root commit flowing into manifest-schema passes", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/") {
        sendJson(res, 200, { commit: "cafef00d" });
        return;
      }
      if (req.url === "/openapi.json") {
        sendJson(res, 200, { paths: { "/api/v1/assets": { post: { parameters: [] } } } });
        return;
      }
      if (req.url === "/api/v1/assets/schema/furniture") {
        sendJson(res, 200, furnitureSchema());
        return;
      }
      if (req.url === "/api/v1/assets/schema/character") {
        sendJson(res, 200, minimalIdNameSchema());
        return;
      }
      if (req.url === "/api/v1/assets/schema/pet") {
        sendJson(res, 200, minimalIdNameSchema());
        return;
      }
      if (req.url === "/api/v1/assets?limit=1") {
        sendJson(res, 200, { assets: [], total: 0 });
        return;
      }
      sendJson(res, 404, {});
    });
    try {
      const context: CheckContext = {};
      const results = [];
      for (const check of CHECKS) results.push(await check(server.baseUrl, context, TIMEOUT_MS));
      expect(results).toHaveLength(6);
      expect(results.every((result) => result.status === "pass")).toBe(true);
      expect(results.map((result) => result.name)).toEqual([
        "root",
        "openapi-query-shape",
        "manifest-schema-furniture",
        "manifest-schema-character",
        "manifest-schema-pet",
        "assets-list",
      ]);
    } finally {
      await server.close();
    }
  });
});
