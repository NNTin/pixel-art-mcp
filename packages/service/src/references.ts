/**
 * Port of `src/pixel_art_mcp/projects/references.py`: reference-image ingestion (upload
 * normalization + SSRF-safe URL download). See `docs/typescript-rewrite.md`'s Phase 6 note --
 * this is flagged as the second-highest fidelity/security risk in the whole rewrite, after
 * image encoding fidelity itself.
 *
 * ## SSRF protections, and exactly how each one is implemented here
 *
 * `publicTarget` is the actual security boundary: before any DNS or network activity, it
 * requires a `https` URL with no userinfo, no fragment, and a port that's either absent or
 * exactly `443` (see the checks in `publicTarget` below). It then resolves the hostname via
 * `node:dns/promises`, and requires **every** resolved address (IPv4 and IPv6) to be a public/
 * global address per `./net/ip-range.js` (a from-scratch port of CPython's
 * `ipaddress.ip_address(ip).is_global`, verified against a live interpreter -- see that module's
 * doc comment).
 *
 * **Anti-DNS-rebinding / IP pinning.** `publicTarget` returns the *validated* IP alongside the
 * original hostname, and `downloadReference` never lets the HTTP client re-resolve DNS at
 * connect time -- it dials that exact IP. This matters because a second DNS lookup between
 * validation and connection could return a different, attacker-controlled address (classic
 * TOCTOU/DNS-rebinding). Node's built-in `fetch` has no public API for "connect to this IP but
 * send this Host/SNI", so this uses **undici** (Node's own bundled HTTP client, added here as an
 * explicit dependency for a pinned version and a documented API surface) directly: a fresh
 * `undici.Client` per hop, constructed with a custom `connect` function (matching undici's
 * documented `Client.Options.connect: buildConnector.connector` extension point -- see
 * `pinnedConnector` below) that dials `tls.connect({ host: pinnedIp, servername: hostname })`
 * itself, bypassing Node's DNS resolver entirely (`net`/`tls`.connect never resolve a literal IP
 * string). `servername` is also what Node's TLS stack validates the peer certificate against, so
 * certificate validation still checks the real hostname, not the IP. The `Host` header is set
 * explicitly to the original hostname on every request for the same reason. This exact mechanism
 * was spiked against a local HTTPS server before being written here for production (see this
 * package's final report) to confirm undici's public `connect` option is real, documented, and
 * behaves as expected -- not a guess.
 *
 * **Redirect re-validation.** `downloadReference` never lets undici/the underlying socket follow
 * redirects automatically (a plain `Client.request` doesn't auto-follow -- this is "manual
 * redirects" by construction, not a flag). Each 3xx response's `Location` header is resolved
 * against the current URL and the *resulting* URL is re-validated through `publicTarget` from
 * scratch (fresh DNS resolution, fresh pin) before it is ever dialed -- this is what closes the
 * classic "SSRF via redirect" bypass, where an attacker's server returns a 302 to
 * `http://169.254.169.254/...` only after the initial URL passed validation. Capped at 4 hops.
 *
 * **Never log/return the URL.** Every network/HTTP/timeout error occurring during the fetch
 * collapses to one fixed, generic `DomainError` message with no chained cause (so the original
 * error object -- which may embed the URL, e.g. in a `ConnectError`'s message, or a signed URL's
 * query string -- is fully detached, not just hidden). `DomainError`s raised deliberately inside
 * this function (invalid redirect, too many redirects, body-size limit) keep their own specific,
 * URL-free messages and are re-thrown as-is rather than swallowed into the generic one. This is
 * the same asymmetry the Python source has (`except (httpx.HTTPError, TimeoutError)` doesn't
 * catch `DomainError`) and is deliberately preserved, not an oversight -- see `downloadReference`.
 */

import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";

import { parsePngChunks } from "@pixel-art-mcp/imaging";
import { DomainError } from "@pixel-art-mcp/schema";
import sharp, { type Metadata } from "sharp";
import { Client, type buildConnector } from "undici";

import { isGlobalAddress } from "./net/ip-range.js";

export interface ReferenceLimits {
  maxUploadBytes: number;
  maxImagePixels: number;
}

export interface NormalizeReferenceResult {
  width: number;
  height: number;
  /** SHA-256 hex digest of the raw *input* bytes, not the normalized PNG. */
  sha256: string;
  extension: "png" | "jpg" | "webp";
}

const EXTENSION_BY_FORMAT = { png: "png", jpeg: "jpg", webp: "webp" } as const;
type AllowedFormat = keyof typeof EXTENSION_BY_FORMAT;

const INVALID_IMAGE_MESSAGE = "Invalid PNG, JPEG, or WebP reference image";

/**
 * Sniffs the on-the-wire container format from magic bytes alone, restricted to exactly the
 * three formats Python's `Image.open(..., formats=["PNG", "JPEG", "WEBP"])` accepts. This check
 * runs *before* the data is ever handed to `sharp`/libvips, so an attacker can't reach any of
 * libvips' other format loaders (SVG/TIFF/GIF/HEIF/...) -- e.g. content sniffing alone would
 * otherwise happily hand `<svg>...` bytes named `photo.png` to libvips' SVG (librsvg) loader.
 */
function sniffImageFormat(data: Uint8Array): AllowedFormat | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "jpeg";
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

/**
 * Detects an animated PNG (APNG) by scanning for an `acTL` chunk -- the presence of animation
 * control data, per the APNG spec -- without decoding any pixel data. `libvips`/`sharp` has no
 * APNG multi-frame support at all (verified empirically: `sharp(apngBuffer, { animated: true
 * }).metadata()` reports no `pages` for a real APNG file, unlike animated WEBP/GIF where it
 * does), so this reuses `@pixel-art-mcp/imaging`'s existing `parsePngChunks` -- a pure
 * header-walk, bounded by the file's own (already upload-size-capped) length -- instead.
 */
function isAnimatedPng(data: Uint8Array): boolean {
  try {
    return parsePngChunks(Buffer.from(data)).some((chunk) => chunk.type === "acTL");
  } catch {
    // Malformed PNG: let sharp's real decode step raise the actual "invalid image" error.
    return false;
  }
}

/**
 * Port of `normalize_reference`: validates, decodes, and normalizes an uploaded reference image,
 * writing `original.<ext>` (raw bytes, unmodified), `image.png` (normalized RGBA PNG,
 * EXIF-orientation corrected), and `thumbnail.png` (resized to fit within 512x512) into
 * `directory`.
 *
 * Image decoding library choice: `sharp` (native libvips), not a pure-JS/WASM decoder -- see
 * this package's final report for the full investigation (pure-JS JPEG/WebP decode + EXIF +
 * quality resampling were evaluated and found inadequate for *hostile, arbitrary* third-party
 * input specifically). `sharp`'s own `limitInputPixels` guard (checked against the container
 * header, before full pixel decode) is used as defense-in-depth alongside an explicit
 * width*height check performed first, matching Python's check ordering and exact error text.
 */
export async function normalizeReference(
  data: Uint8Array,
  directory: string,
  limits: ReferenceLimits,
): Promise<NormalizeReferenceResult> {
  if (data.length === 0 || data.length > limits.maxUploadBytes) {
    throw new DomainError("Reference is empty or exceeds the upload size limit", 413);
  }

  const sniffed = sniffImageFormat(data);
  if (!sniffed) {
    throw new DomainError(INVALID_IMAGE_MESSAGE);
  }

  // `limitInputPixels: false` here deliberately: metadata() only reads the container header (it
  // never decodes pixel data, regardless of this setting), and disabling sharp's own guard for
  // *this* call lets the explicit width*height check below run first and control the error
  // message/ordering, matching Python's `Image.open()` -> check -> raise sequence exactly. The
  // full-decode call further down still passes the real limit as defense-in-depth.
  let metadata: Metadata;
  try {
    metadata = await sharp(Buffer.from(data), {
      animated: true,
      limitInputPixels: false,
    }).metadata();
  } catch {
    throw new DomainError(INVALID_IMAGE_MESSAGE);
  }
  if (metadata.format !== sniffed) {
    throw new DomainError(INVALID_IMAGE_MESSAGE);
  }

  if (metadata.width * metadata.height > limits.maxImagePixels) {
    throw new DomainError("Reference exceeds the decoded pixel limit", 413);
  }

  const animated = sniffed === "png" ? isAnimatedPng(data) : (metadata.pages ?? 1) > 1;
  if (animated) {
    throw new DomainError("Upload a still image, not an animated image");
  }

  let normalizedPng: Buffer;
  let thumbnailPng: Buffer;
  try {
    normalizedPng = await sharp(Buffer.from(data), { limitInputPixels: limits.maxImagePixels })
      .rotate() // EXIF-orientation auto-transpose, matching `ImageOps.exif_transpose`.
      .ensureAlpha() // `.convert("RGBA")`: force an alpha channel if the source lacks one.
      .png()
      .toBuffer();
    thumbnailPng = await sharp(normalizedPng)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .png()
      .toBuffer();
  } catch {
    throw new DomainError(INVALID_IMAGE_MESSAGE);
  }
  const normalizedMeta = await sharp(normalizedPng).metadata();

  await mkdir(directory, { recursive: true });
  const extension = EXTENSION_BY_FORMAT[sniffed];
  await writeFile(path.join(directory, `original.${extension}`), data);
  await writeFile(path.join(directory, "image.png"), normalizedPng);
  await writeFile(path.join(directory, "thumbnail.png"), thumbnailPng);

  return {
    width: normalizedMeta.width,
    height: normalizedMeta.height,
    sha256: createHash("sha256").update(data).digest("hex"),
    extension,
  };
}

export interface PinnedTarget {
  /** The already-validated address the connection must be pinned to. */
  pinnedIp: string;
  /** The original hostname -- used for the `Host` header and TLS SNI, never for a fresh lookup. */
  hostname: string;
  /** `pathname + search` of the validated URL (no fragment -- rejected before this point). */
  path: string;
  /**
   * Overrides the dialed port. Real `publicTarget` never sets this -- a validated reference URL
   * can only ever mean port 443, which `pinnedConnector` defaults to -- it exists only so tests
   * can pin `downloadReference` at a local test server on an ephemeral port without a real
   * DNS/certificate setup (see `references.test.ts`'s local-HTTPS-server tests).
   */
  port?: number;
  /**
   * Extra trust anchor(s) for the pinned TLS connection. Real `publicTarget` never sets this --
   * production always verifies against the system trust store only. Exists so tests can trust a
   * locally-generated test CA without disabling certificate verification (`rejectUnauthorized`
   * stays `true` either way) -- the standard way to test a TLS-pinning client against a local
   * server.
   */
  ca?: string | Buffer | (string | Buffer)[];
}

export type DnsLookup = (hostname: string) => Promise<LookupAddress[]>;

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true });
}

/**
 * Port of `public_target`: the SSRF security boundary. Validates a URL is safe to fetch, then
 * resolves and pins it. See this module's top doc comment for the full protection rationale.
 */
export async function publicTarget(
  url: string,
  lookup: DnsLookup = defaultLookup,
): Promise<PinnedTarget> {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      (parsed.port !== "" && parsed.port !== "443") ||
      parsed.hash
    ) {
      throw new Error("Expected a public HTTPS URL without credentials");
    }
    const resolved = await lookup(parsed.hostname);
    const addresses = resolved.map((entry) => entry.address);
    const firstAddress = addresses[0];
    if (firstAddress === undefined || addresses.some((ip) => !isGlobalAddress(ip))) {
      throw new Error("Private, loopback, link-local, and reserved addresses are disallowed");
    }
    // Pin the connection to an already-validated IP to avoid DNS rebinding.
    return {
      pinnedIp: firstAddress,
      hostname: parsed.hostname,
      path: `${parsed.pathname || "/"}${parsed.search}`,
    };
  } catch {
    throw new DomainError("Reference URL must resolve only to public HTTPS addresses");
  }
}

/**
 * Builds an undici `connect` function (see `Client.Options.connect` /
 * `buildConnector.connector`) that dials `pinnedIp` directly -- bypassing Node's DNS resolver
 * entirely, since `tls.connect` never resolves a literal IP string -- while presenting `hostname`
 * as both the TLS SNI value and the value Node validates the peer certificate against.
 */
function pinnedConnector(
  pinnedIp: string,
  hostname: string,
  port = 443,
  ca?: string | Buffer | (string | Buffer)[],
): buildConnector.connector {
  return (_options, callback) => {
    let settled = false;
    const socket = tls.connect({ host: pinnedIp, port, servername: hostname, ca });
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(err, null);
    };
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      socket.removeListener("error", onError);
      callback(null, socket);
    });
  };
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 4;
const OVERALL_TIMEOUT_MS = 30_000;
const PER_REQUEST_TIMEOUT_MS = 15_000;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Abandons a response body we're deliberately not reading to completion (a redirect, or a
 * non-2xx status). A bare `.destroy()` on an unconsumed `BodyReadable` emits an async `error`
 * event; with no listener attached, Node treats that as an unhandled error and crashes the
 * process, so a no-op listener is always attached first.
 */
function abandonBody(body: {
  on: (event: "error", listener: (err: Error) => void) => void;
  destroy: () => void;
}): void {
  body.on("error", () => {
    /* deliberately unconsumed -- see doc comment */
  });
  body.destroy();
}

/**
 * Port of `download_reference`. Every HTTP/timeout error collapses to one generic message and
 * this function must never log or return the URL or its query string (it may contain signed-URL
 * secrets) -- see this module's top doc comment.
 */
export async function downloadReference(
  url: string,
  limits: ReferenceLimits,
  resolveTarget: (url: string) => Promise<PinnedTarget> = publicTarget,
): Promise<Uint8Array> {
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => {
    overallController.abort(new Error("Reference download timed out"));
  }, OVERALL_TIMEOUT_MS);
  try {
    let currentUrl = url;
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      // DomainErrors raised here (an invalid/non-public target) are intentionally NOT caught by
      // the generic `catch` below -- they propagate with their own specific, URL-free message.
      const target = await resolveTarget(currentUrl);
      const client = new Client(`https://${target.hostname}`, {
        connect: pinnedConnector(target.pinnedIp, target.hostname, target.port, target.ca),
        connectTimeout: PER_REQUEST_TIMEOUT_MS,
        headersTimeout: PER_REQUEST_TIMEOUT_MS,
        bodyTimeout: PER_REQUEST_TIMEOUT_MS,
      });
      try {
        const perHopSignal = AbortSignal.any([
          overallController.signal,
          AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
        ]);
        const response = await client.request({
          path: target.path,
          method: "GET",
          // Different hostnames can pin to the same IP; each hop gets its own fresh Client (no
          // keep-alive/session reuse across hostnames), mirroring Python's explicit
          // `Connection: close` to avoid reusing a TLS session authenticated for a different host.
          headers: { host: target.hostname, connection: "close" },
          signal: perHopSignal,
        });

        if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
          abandonBody(response.body);
          const location = firstHeaderValue(response.headers["location"]);
          if (!location) {
            throw new DomainError("Reference download returned an invalid redirect");
          }
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          abandonBody(response.body);
          throw new Error(`Reference download received HTTP ${String(response.statusCode)}`);
        }

        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of response.body as AsyncIterable<Buffer>) {
          total += chunk.length;
          if (total > limits.maxUploadBytes) {
            abandonBody(response.body);
            throw new DomainError("Reference exceeds the upload size limit", 413);
          }
          chunks.push(chunk);
        }
        return new Uint8Array(Buffer.concat(chunks));
      } finally {
        // Always `destroy` (never the graceful `close`): each hop gets a fresh, single-use
        // client, and a redirect/error path may have left its body only partially drained.
        await client.destroy();
      }
    }
    throw new DomainError("Too many reference download redirects");
  } catch (err) {
    if (err instanceof DomainError) throw err;
    // Deliberately no `cause`/chaining: the original error (a connect/timeout/HTTP failure) may
    // embed the URL or its query string, e.g. in a connection error's message -- never log/return it.
    throw new DomainError("Reference download failed or expired; upload the image again");
  } finally {
    clearTimeout(overallTimer);
  }
}
