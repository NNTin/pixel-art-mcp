/**
 * Port of `tests/unit/test_references.py`'s behavior (Phase 6a only ports `normalize_reference`/
 * `public_target`/`download_reference` themselves, not the MCP `service.add_reference*` wiring
 * around them -- Phase 6b -- so these tests call the exported functions directly).
 *
 * The `downloadReference` suite exercises the *real* SSRF-critical machinery end to end --
 * `pinnedConnector`'s actual `tls.connect`, the real Host/SNI handling, the real redirect loop --
 * against a local HTTPS server (self-signed cert generated once via the system `openssl` CLI,
 * trusted only for these tests via `PinnedTarget.ca`; `rejectUnauthorized` is never relaxed).
 * `publicTarget`'s own DNS-resolution + is-global check is tested in isolation via its injectable
 * `lookup` parameter, per this package's brief: `127.0.0.1` itself must be *rejected* as
 * non-global, so it can't double as a "happy path" DNS answer.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createImage, encodeApng, setPixel } from "@pixel-art-mcp/imaging";
import { DomainError } from "@pixel-art-mcp/schema";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  downloadReference,
  normalizeReference,
  publicTarget,
  type PinnedTarget,
  type ReferenceLimits,
} from "./references.js";

const LIMITS: ReferenceLimits = { maxUploadBytes: 1024 * 1024, maxImagePixels: 4_000_000 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-service-references-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function pngBuffer(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

describe("normalizeReference", () => {
  it("normalizes an upload and returns width/height/sha256/extension", async () => {
    const png = await pngBuffer(24, 32, [200, 40, 40]);
    const result = await normalizeReference(new Uint8Array(png), dir, LIMITS);
    expect(result.width).toBe(24);
    expect(result.height).toBe(32);
    expect(result.extension).toBe("png");
    const { createHash } = await import("node:crypto");
    expect(result.sha256).toBe(createHash("sha256").update(png).digest("hex"));

    const normalized = await sharp(path.join(dir, "image.png")).metadata();
    expect(normalized.channels).toBe(4);
    expect(normalized.hasAlpha).toBe(true);
    const original = readFileSync(path.join(dir, "original.png"));
    expect(original).toEqual(png);
  });

  it("rejects empty input and input over the upload size limit", async () => {
    await expect(normalizeReference(new Uint8Array(0), dir, LIMITS)).rejects.toThrow(DomainError);
    const png = await pngBuffer(4, 4, [1, 2, 3]);
    await expect(
      normalizeReference(new Uint8Array(png), dir, { ...LIMITS, maxUploadBytes: 5 }),
    ).rejects.toThrow(/size limit/);
  });

  it("rejects non-image and disguised-format input without invoking any other decoder", async () => {
    for (const data of [
      new TextEncoder().encode("not an image"),
      new Uint8Array(0),
      new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
    ]) {
      if (data.length === 0) continue; // covered by the empty-input case above
      await expect(normalizeReference(data, dir, LIMITS)).rejects.toThrow(
        /Invalid PNG, JPEG, or WebP/,
      );
    }
  });

  it("rejects a decoded pixel count over the limit", async () => {
    const png = await pngBuffer(100, 100, [5, 5, 5]);
    await expect(
      normalizeReference(new Uint8Array(png), dir, { ...LIMITS, maxImagePixels: 100 }),
    ).rejects.toThrow(/pixel limit/);
  });

  it("applies EXIF orientation before returning width/height", async () => {
    const jpeg = await sharp({
      create: { width: 20, height: 10, channels: 3, background: { r: 80, g: 80, b: 200 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await normalizeReference(new Uint8Array(jpeg), dir, LIMITS);
    expect([result.width, result.height]).toEqual([10, 20]);
    expect(result.extension).toBe("jpg");
  });

  it("rejects an animated PNG (APNG)", async () => {
    const red = createImage(10, 10);
    const blue = createImage(10, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        setPixel(red, x, y, [255, 0, 0, 255]);
        setPixel(blue, x, y, [0, 0, 255, 255]);
      }
    }
    const apng = encodeApng([red, blue], { delayMs: 100 });
    await expect(normalizeReference(new Uint8Array(apng), dir, LIMITS)).rejects.toThrow(
      /still image/,
    );
  });

  it("rejects an animated WEBP", async () => {
    const frame1 = await pngBuffer(10, 10, [255, 0, 0]);
    const frame2 = await pngBuffer(10, 10, [0, 0, 255]);
    const animatedWebp = await sharp([frame1, frame2], { join: { animated: true } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    await expect(normalizeReference(new Uint8Array(animatedWebp), dir, LIMITS)).rejects.toThrow(
      /still image/,
    );
  });

  it("produces a thumbnail bounded to 512x512 without upscaling a smaller image", async () => {
    const png = await pngBuffer(24, 32, [10, 200, 10]);
    await normalizeReference(new Uint8Array(png), dir, LIMITS);
    const thumb = await sharp(path.join(dir, "thumbnail.png")).metadata();
    expect(thumb.width).toBe(24);
    expect(thumb.height).toBe(32);
  });
});

describe("publicTarget", () => {
  const publicLookup = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

  it.each([
    "file:///etc/passwd",
    "http://example.com/a.png",
    "https://user:pass@example.com/a.png",
    "https://example.com:8443/a.png",
    "https://example.com/a.png#frag",
    "not a url at all",
  ])("rejects a malformed/unsafe URL shape: %s", async (url) => {
    await expect(publicTarget(url, publicLookup)).rejects.toThrow(DomainError);
  });

  it("accepts an explicit :443 the same as an implicit default port", async () => {
    const target = await publicTarget("https://example.com:443/a.png", publicLookup);
    expect(target.hostname).toBe("example.com");
  });

  it("rejects when DNS resolves to a private/loopback/link-local address (IPv4)", async () => {
    await expect(
      publicTarget("https://example.com/photo.png", () =>
        Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      ),
    ).rejects.toThrow(DomainError);
  });

  it("rejects when DNS resolves to a private/loopback/link-local address (IPv6)", async () => {
    await expect(
      publicTarget("https://example.com/photo.png", () =>
        Promise.resolve([{ address: "fe80::1", family: 6 }]),
      ),
    ).rejects.toThrow(DomainError);
  });

  it("rejects if ANY resolved address is non-global, even when another is public", async () => {
    await expect(
      publicTarget("https://example.com/photo.png", () =>
        Promise.resolve([
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ]),
      ),
    ).rejects.toThrow(DomainError);
  });

  it("rejects when DNS resolution fails or returns nothing", async () => {
    await expect(
      publicTarget("https://example.com/photo.png", () => Promise.resolve([])),
    ).rejects.toThrow(DomainError);
    await expect(
      publicTarget("https://example.com/photo.png", () => Promise.reject(new Error("ENOTFOUND"))),
    ).rejects.toThrow(DomainError);
  });

  it("pins to the first validated address and preserves hostname/path/query", async () => {
    const target = await publicTarget("https://example.com/photo.png?token=test", publicLookup);
    expect(target.pinnedIp).toBe("93.184.216.34");
    expect(target.hostname).toBe("example.com");
    expect(target.path).toBe("/photo.png?token=test");
  });
});

// --- Local HTTPS server used only by the downloadReference suite below. ---

let opensslAvailable = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  opensslAvailable = false;
}

const TEST_HOSTNAME = "pixel-art-mcp.test";
let certDir: string;
let testCa: Buffer;
let testCert: Buffer;
let testKey: Buffer;

beforeAll(() => {
  if (!opensslAvailable) return;
  certDir = mkdtempSync(path.join(tmpdir(), "pixel-art-service-tls-"));
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      `/CN=${TEST_HOSTNAME}`,
      "-addext",
      `subjectAltName=DNS:${TEST_HOSTNAME}`,
    ],
    { stdio: "ignore" },
  );
  testCert = readFileSync(certPath);
  testKey = readFileSync(keyPath);
  testCa = testCert;
});

afterAll(() => {
  if (!opensslAvailable) return;
  rmSync(certDir, { recursive: true, force: true });
});

interface TestServer {
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<TestServer> {
  const server = https.createServer({ cert: testCert, key: testKey }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A `resolveTarget` stub that skips DNS entirely and pins straight at the local test server,
 * still routing every hop through the real path/hostname computation `publicTarget` would do. */
function pinAtTestServer(port: number, reject = new Set<string>()) {
  return (url: string): Promise<PinnedTarget> => {
    const parsed = new URL(url);
    if (reject.has(parsed.hostname)) {
      return Promise.reject(new DomainError("Reference URL must resolve only to public HTTPS addresses"));
    }
    return Promise.resolve({
      pinnedIp: "127.0.0.1",
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      port,
      ca: testCa,
    });
  };
}

describe.skipIf(!opensslAvailable)("downloadReference (local HTTPS server)", () => {
  it("downloads over the pinned connection, presenting the correct Host header and SNI", async () => {
    const seenHosts: (string | undefined)[] = [];
    const png = await pngBuffer(6, 6, [9, 9, 9]);
    const server = await startTestServer((req, res) => {
      seenHosts.push(req.headers.host);
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    });
    try {
      const data = await downloadReference(
        `https://${TEST_HOSTNAME}/photo.png`,
        LIMITS,
        pinAtTestServer(server.port),
      );
      expect(Buffer.from(data)).toEqual(png);
      expect(seenHosts).toEqual([TEST_HOSTNAME]);
    } finally {
      await server.close();
    }
  });

  it("follows a redirect chain, re-validating (and re-pinning) each hop", async () => {
    const visited: string[] = [];
    const png = await pngBuffer(4, 4, [1, 1, 1]);
    const server = await startTestServer((req, res) => {
      visited.push(req.url ?? "");
      if (req.url === "/redirect") {
        res.writeHead(302, { location: `https://${TEST_HOSTNAME}/final` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    });
    try {
      const data = await downloadReference(
        `https://${TEST_HOSTNAME}/redirect`,
        LIMITS,
        pinAtTestServer(server.port),
      );
      expect(Buffer.from(data)).toEqual(png);
      expect(visited).toEqual(["/redirect", "/final"]);
    } finally {
      await server.close();
    }
  });

  it("stops following redirects after the hop cap and reports a specific, non-generic error", async () => {
    const server = await startTestServer((req, res) => {
      res.writeHead(302, { location: `https://${TEST_HOSTNAME}${req.url}` });
      res.end();
    });
    try {
      await expect(
        downloadReference(`https://${TEST_HOSTNAME}/loop`, LIMITS, pinAtTestServer(server.port)),
      ).rejects.toThrow("Too many reference download redirects");
    } finally {
      await server.close();
    }
  });

  it("rejects a redirect that fails re-validation (e.g. resolves off-target), not silently following it", async () => {
    const server = await startTestServer((req, res) => {
      res.writeHead(302, { location: "https://private.example.test/photo" });
      res.end();
    });
    try {
      await expect(
        downloadReference(
          `https://${TEST_HOSTNAME}/redirect`,
          LIMITS,
          pinAtTestServer(server.port, new Set(["private.example.test"])),
        ),
      ).rejects.toThrow("Reference URL must resolve only to public HTTPS addresses");
    } finally {
      await server.close();
    }
  });

  it("reports an invalid-redirect error when a 3xx response has no Location header", async () => {
    const server = await startTestServer((_req, res) => {
      res.writeHead(302, {});
      res.end();
    });
    try {
      await expect(
        downloadReference(`https://${TEST_HOSTNAME}/redirect`, LIMITS, pinAtTestServer(server.port)),
      ).rejects.toThrow("Reference download returned an invalid redirect");
    } finally {
      await server.close();
    }
  });

  it("aborts once the download exceeds the upload size limit", async () => {
    const big = Buffer.alloc(64 * 1024, 7);
    const server = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(big);
    });
    try {
      await expect(
        downloadReference(`https://${TEST_HOSTNAME}/big`, { ...LIMITS, maxUploadBytes: 1024 }, pinAtTestServer(server.port)),
      ).rejects.toThrow(/size limit/);
    } finally {
      await server.close();
    }
  });

  it("collapses every other network/HTTP failure into one generic message and never leaks the URL", async () => {
    const secretUrl = `https://${TEST_HOSTNAME}/photo?secret=do-not-log`;
    const resolveTarget = (): Promise<PinnedTarget> => Promise.reject(new Error(secretUrl));
    let caught: unknown;
    try {
      await downloadReference(secretUrl, LIMITS, resolveTarget);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const message = (caught as DomainError).message;
    expect(message).toBe("Reference download failed or expired; upload the image again");
    expect(message).not.toContain("secret");
    expect(message).not.toContain(TEST_HOSTNAME);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("collapses a non-2xx/non-redirect HTTP status into the generic message", async () => {
    const server = await startTestServer((_req, res) => {
      res.writeHead(500, {});
      res.end("server error");
    });
    try {
      await expect(
        downloadReference(`https://${TEST_HOSTNAME}/broken`, LIMITS, pinAtTestServer(server.port)),
      ).rejects.toThrow("Reference download failed or expired; upload the image again");
    } finally {
      await server.close();
    }
  });
});
