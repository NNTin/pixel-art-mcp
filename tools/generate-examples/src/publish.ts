#!/usr/bin/env node
/**
 * Port of `scripts/publish_examples_to_pixel_index.py`: publish every example's real package zip
 * (as written by `index.ts`'s `generate()`, one folder per example) to a running pixel-index
 * instance, actually calling `POST /api/v1/assets` -- unlike `tools/contracts-pixel-index`, which
 * only checks the *shape* of a manifest against a live schema, a pass here means "pixel-index's
 * real decode/ingest logic accepted this exact zip".
 *
 * A multi-clip furniture package (e.g. `rain-barrel`'s empty/partial/full states, `thermometer`'s
 * cold/room/hot) is not directly uploadable to pixel-index -- see `pixel-index-packaging.ts`'s
 * doc comment for why -- so `splitUnits` reuses the same `splitMultiClipZip` `index.ts` uses to
 * give each clip its own gallery download link, publishing each clip as its own separate
 * pixel-index asset instead.
 *
 * **Confidence note** (see this port's introducing phase's report): this is a faithful,
 * line-for-line transliteration of the Python original's HTTP POST loop -- small, self-contained,
 * no complex behavior invented. What this port does *not* change or newly validate is whether
 * pixel-index's real API actually accepts the resulting requests; that risk is identical in
 * either language and can only be checked against a real running pixel-index instance (this
 * phase had none available -- see `.github/workflows/pixel-index-publish-check.yml`'s own doc
 * comment for why no such environment exists outside that workflow's own CI run).
 *
 * Run:
 *   node dist/publish.js --pixel-index-url http://localhost:18080 \
 *     --examples-dir tmp/asset-workflow --token <bearer token>
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { splitMultiClipZip } from "./pixel-index-packaging.js";

const PACKAGE_FILENAMES = [
  "pixel-agents.zip",
  "pixel-agents-character.zip",
  "pixel-agents-pet.zip",
] as const;

interface Unit {
  readonly label: string;
  readonly data: Uint8Array;
}

/** One zip this script will actually POST -- either a package as-is, or one clip split out of a
 * multi-manifest furniture package. */
export function splitUnits(exampleKey: string, packageFilename: string, data: Uint8Array): Unit[] {
  const clips = splitMultiClipZip(data);
  if (clips.length === 0) {
    return [{ label: `${exampleKey}/${packageFilename}`, data }];
  }
  return clips.map((clip) => ({
    label: `${exampleKey}/${packageFilename} [${clip.assetId}]`,
    data: clip.data,
  }));
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findPackage(exampleDir: string): { filename: string; data: Uint8Array } | undefined {
  for (const filename of PACKAGE_FILENAMES) {
    const filePath = path.join(exampleDir, filename);
    if (isFile(filePath)) return { filename, data: readFileSync(filePath) };
  }
  return undefined;
}

export async function publish(
  baseUrl: string,
  examplesDir: string,
  token: string,
  only: readonly string[],
): Promise<boolean> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" };
  let exampleNames = readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "webview")
    .map((entry) => entry.name)
    .sort();
  if (only.length > 0) {
    exampleNames = exampleNames.filter((name) => only.includes(name));
  }

  const root = baseUrl.replace(/\/$/, "");
  let allOk = true;
  let total = 0;
  for (const name of exampleNames) {
    const found = findPackage(path.join(examplesDir, name));
    if (!found) {
      console.log(`SKIP  ${name}: no installable package zip found`);
      continue;
    }
    for (const unit of splitUnits(name, found.filename, found.data)) {
      total += 1;
      const response = await fetch(`${root}/api/v1/assets`, {
        method: "POST",
        headers,
        body: unit.data,
      });
      if (response.status === 201) {
        const body = (await response.json()) as { assetId?: string };
        console.log(`PASS  ${unit.label}  -> 201 (assetId=${body.assetId ?? "?"})`);
      } else {
        allOk = false;
        const text = await response.text();
        console.log(`FAIL  ${unit.label}  -> ${String(response.status)} ${text}`);
      }
    }
  }
  console.log(`\n${allOk ? "all" : "not all"} ${String(total)} upload(s) accepted`);
  return allOk;
}

interface Args {
  readonly pixelIndexUrl: string;
  readonly examplesDir: string;
  readonly token: string;
  readonly only: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  let pixelIndexUrl: string | undefined;
  let examplesDir: string | undefined;
  let token: string | undefined;
  let only: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--pixel-index-url": {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error("Missing value for --pixel-index-url");
        pixelIndexUrl = value;
        break;
      }
      case "--examples-dir": {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error("Missing value for --examples-dir");
        examplesDir = path.resolve(value);
        break;
      }
      case "--token": {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error("Missing value for --token");
        token = value;
        break;
      }
      case "--only": {
        const rest: string[] = [];
        while (i + 1 < argv.length && !(argv[i + 1] ?? "").startsWith("--")) {
          i += 1;
          const value = argv[i];
          if (value !== undefined) rest.push(value);
        }
        only = rest;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  if (pixelIndexUrl === undefined) throw new Error("--pixel-index-url is required");
  if (examplesDir === undefined) throw new Error("--examples-dir is required");
  if (token === undefined) throw new Error("--token is required");
  return { pixelIndexUrl, examplesDir, token, only };
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  publish(args.pixelIndexUrl, args.examplesDir, args.token, args.only)
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
