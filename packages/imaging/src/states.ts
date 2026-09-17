/**
 * Export named appearance states from one render, with shared framing and palette. Verbatim port
 * of `src/pixel_art_mcp/imaging/states.py` (262 lines).
 */

import fs from "node:fs";
import path from "node:path";

import {
  DomainError,
  RenderOptionsSchema,
  renderOptionsFrames,
  renderOptionsRenderFrames,
  renderStateFrames,
  type RenderOptions,
} from "@pixel-art-mcp/schema";

import { saveAnimatedGif } from "./gif.js";
import {
  createImage,
  isWithinDirectory,
  pasteCrop,
  readPng,
  resizeNearest,
  thumbnailNearest,
  writePng,
  type RGBAImage,
} from "./image.js";
import { defined } from "./internal.js";
import { zipDirectory } from "./pack-zip.js";
import { ACTIVATION } from "./pixel-agents.js";
import {
  exportSheet,
  paletteFromSamples,
  sampleSourceColors,
  type RenderManifestLike,
} from "./pixels.js";
import { rgbToHex, type Rgb } from "./quantize.js";
import { STATES_PLAYER_HTML_TEMPLATE } from "./templates.js";

interface StatesManifestFrame {
  angle: number;
  frame: number;
  filename: string;
  pivot: [number, number];
  [key: string]: unknown;
}

export interface StatesExportManifest extends RenderManifestLike {
  frames: readonly StatesManifestFrame[];
}

function cellKey(angle: number, frame: number): string {
  return `${String(angle)}:${String(frame)}`;
}

function sameSequence(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(([angle, frame], index) => {
    const other = b[index];
    return other?.[0] === angle && other[1] === frame;
  });
}

interface ChildFrame {
  filename: string;
  rect: [number, number, number, number];
  [key: string]: unknown;
}

interface ChildDirection {
  angle: number;
  row: number;
  frame_indices: number[];
  animation: string | null;
  [key: string]: unknown;
}

interface ChildSpritesheetMetadata {
  frames: readonly ChildFrame[];
  directions: readonly ChildDirection[];
  pixel_agents: Record<string, unknown> | null;
  off_image: string | null;
  comparison: { off_image: string | null } | null;
  [key: string]: unknown;
}

export function exportStates(
  rawDir: string,
  outputDir: string,
  manifest: StatesExportManifest,
  options: RenderOptions,
  projectId: string,
  revisionId: string,
): void {
  const states = options.states;
  if (!states) throw new Error("exportStates requires options.states");

  const renderedFrames = renderOptionsRenderFrames(options);
  const entries = manifest.frames;
  const expectedKeys: [number, number][] = [];
  for (const angle of options.angles)
    for (const frame of renderedFrames) expectedKeys.push([angle, frame]);
  const actualKeys: [number, number][] = entries.map((e) => [e.angle, e.frame]);
  if (!sameSequence(actualKeys, expectedKeys)) {
    throw new DomainError("Render output is an incomplete or unordered state sequence");
  }
  const byKey = new Map<string, StatesManifestFrame>();
  for (const entry of entries) byKey.set(cellKey(entry.angle, entry.frame), entry);

  const resolvedRawDir = path.resolve(rawDir);
  let sourceSamples: Rgb[] = [];
  const sampleBudget = Math.max(1, Math.floor(262_144 / Math.max(1, entries.length)));
  for (const entry of entries) {
    const resolvedPath = path.resolve(rawDir, entry.filename);
    if (!isWithinDirectory(resolvedRawDir, resolvedPath) || path.extname(resolvedPath) !== ".png") {
      throw new DomainError("Invalid render output path");
    }
    const source = readPng(resolvedPath);
    if (
      source.width !== options.width * options.supersampling ||
      source.height !== options.height * options.supersampling
    ) {
      throw new DomainError("Render output has unexpected image dimensions");
    }
    if (options.palette === null) {
      sourceSamples = sourceSamples.concat(
        sampleSourceColors(source, sampleBudget, options.alpha_threshold),
      );
    }
  }
  const colors = paletteFromSamples(sourceSamples, options);
  const palette = colors.map((color) => rgbToHex(color));
  if (palette.length === 1) {
    palette.push(defined(palette[0], "sole palette color") === "#000000" ? "#ffffff" : "#000000");
  }

  const columns = Math.max(...states.map((state) => renderStateFrames(state).length));
  const directionCount = options.angles.length;
  const sheet = createImage(
    columns * options.width,
    states.length * directionCount * options.height,
  );
  const overview = createImage(states.length * options.width, directionCount * options.height);

  const statesOut: Record<string, unknown>[] = [];
  const embedded: Record<string, unknown>[] = [];
  const allFrames: Record<string, unknown>[] = [];
  const target = options.pixel_agents;

  states.forEach((state, stateIndex) => {
    const stateDir = path.join(outputDir, "states", state.id);
    const stateOptionsRaw: Record<string, unknown> = {
      ...options,
      states: null,
      frame_start: state.frame_start,
      frame_end: state.frame_end,
      frame_step: state.frame_step,
      palette,
    };
    if (target) {
      stateOptionsRaw["pixel_agents"] = {
        ...target,
        asset_id: `${target.asset_id}_${state.id.toUpperCase()}`,
        name: `${target.name} — ${state.name}`,
        off_frame: state.off_frame,
      };
    }
    const child: RenderOptions = RenderOptionsSchema.parse(stateOptionsRaw);
    const childRenderFrames = renderOptionsRenderFrames(child);
    const childEntries = child.angles.flatMap((angle) =>
      childRenderFrames.map((frame) =>
        defined(byKey.get(cellKey(angle, frame)), `state frame ${String(angle)}:${String(frame)}`),
      ),
    );
    exportSheet(
      rawDir,
      stateDir,
      { ...manifest, frames: childEntries },
      child,
      projectId,
      revisionId,
    );
    const childMeta = JSON.parse(
      fs.readFileSync(path.join(stateDir, "spritesheet.json"), "utf-8"),
    ) as ChildSpritesheetMetadata;
    const prefix = `states/${state.id}`;
    const stateColumns = renderOptionsFrames(child).length;
    const stateSheet = readPng(path.join(stateDir, "spritesheet.png"));

    // Shorter (e.g. static) states loop within the longest state's frame count so the combined
    // sheet and preview.gif stay fully populated for every column.
    for (let column = 0; column < columns; column++) {
      const sourceColumn = column % stateColumns;
      pasteCrop(
        sheet,
        stateSheet,
        sourceColumn * options.width,
        0,
        options.width,
        directionCount * options.height,
        column * options.width,
        stateIndex * directionCount * options.height,
      );
    }
    for (let direction = 0; direction < directionCount; direction++) {
      pasteCrop(
        overview,
        stateSheet,
        0,
        direction * options.height,
        options.width,
        options.height,
        stateIndex * options.width,
        direction * options.height,
      );
    }

    for (const frame of childMeta.frames) {
      const rect: [number, number, number, number] = [...frame.rect];
      rect[1] += stateIndex * directionCount * options.height;
      allFrames.push({ ...frame, state: state.id, filename: `${prefix}/${frame.filename}`, rect });
    }

    statesOut.push({
      id: state.id,
      name: state.name,
      row_start: stateIndex * directionCount,
      frames: renderOptionsFrames(child),
      metadata: `${prefix}/spritesheet.json`,
      player: `${prefix}/preview.html`,
      pixel_agents: childMeta.pixel_agents,
      directions: childMeta.directions.map((d) => ({
        ...d,
        row: stateIndex * directionCount + d.row,
        frame_indices: d.frame_indices.map((i) => stateIndex * directionCount * columns + i),
        animation: d.animation ? `${prefix}/${d.animation}` : null,
      })),
    });

    function encode(filename: string | null, directory: string = stateDir): string | null {
      if (!filename) return null;
      return fs.readFileSync(path.join(directory, filename)).toString("base64");
    }
    embedded.push({
      name: state.name,
      columns: stateColumns,
      image: encode("spritesheet.png"),
      offImage: encode(childMeta.off_image),
      highImage: encode("comparison/high-resolution.png"),
      highOffImage: encode(childMeta.comparison?.off_image ?? null),
    });

    if (target) {
      const packageSource = path.join(stateDir, "pixel-agents", "assets", "furniture");
      const packageDest = path.join(outputDir, "pixel-agents", "assets", "furniture");
      if (fs.existsSync(packageSource)) {
        fs.mkdirSync(packageDest, { recursive: true });
        fs.cpSync(packageSource, packageDest, { recursive: true });
      }
    }
  });

  writePng(path.join(outputDir, "spritesheet.png"), sheet);
  const previewScale = Math.min(
    4,
    Math.max(1, Math.floor(1024 / Math.max(overview.width, overview.height))),
  );
  let preview = resizeNearest(
    overview,
    overview.width * previewScale,
    overview.height * previewScale,
  );
  if (Math.max(preview.width, preview.height) > 1024) preview = thumbnailNearest(preview, 1024);
  writePng(path.join(outputDir, "preview.png"), preview);

  if (columns > 1) {
    const gifScale = Math.min(
      4,
      Math.max(1, Math.floor(1024 / Math.max(overview.width, overview.height))),
    );
    const gifFrames: RGBAImage[] = [];
    for (let column = 0; column < columns; column++) {
      let composite = createImage(overview.width, overview.height);
      states.forEach((_state, stateIndex) => {
        for (let direction = 0; direction < directionCount; direction++) {
          const row = stateIndex * directionCount + direction;
          pasteCrop(
            composite,
            sheet,
            column * options.width,
            row * options.height,
            options.width,
            options.height,
            stateIndex * options.width,
            direction * options.height,
          );
        }
      });
      composite = resizeNearest(composite, composite.width * gifScale, composite.height * gifScale);
      if (Math.max(composite.width, composite.height) > 1024)
        composite = thumbnailNearest(composite, 1024);
      gifFrames.push(composite);
    }
    saveAnimatedGif(gifFrames, palette, options.fps, path.join(outputDir, "preview.gif"));
  }

  if (target) {
    zipDirectory(path.join(outputDir, "pixel-agents"), path.join(outputDir, "pixel-agents.zip"));
  }

  const metadata = {
    schema_version: 1,
    project_id: projectId,
    revision_id: revisionId,
    image: "spritesheet.png",
    size: [sheet.width, sheet.height],
    columns,
    rows: states.length * directionCount,
    palette,
    transparent: true,
    settings: options,
    frames: allFrames,
    states: statesOut,
    player: "preview.html",
    camera: manifest.camera,
    pixel_agents: target
      ? {
          archive: "pixel-agents.zip",
          activation: ACTIVATION,
          state_selection: "Separate furniture variants; no automatic transitions",
        }
      : null,
  };
  fs.writeFileSync(
    path.join(outputDir, "spritesheet.json"),
    JSON.stringify(metadata, null, 2),
    "utf-8",
  );

  const player = {
    name: target ? target.name : "Sprite states",
    states: embedded,
    width: options.width,
    height: options.height,
    angles: options.angles,
    fps: options.fps,
    columns,
    supersampling: options.supersampling,
    pixelAgents: Boolean(target),
  };
  const json = JSON.stringify(player).replace(/</g, "\\u003c");
  fs.writeFileSync(
    path.join(outputDir, "preview.html"),
    STATES_PLAYER_HTML_TEMPLATE.replace("__PLAYER_DATA__", json),
    "utf-8",
  );

  zipDirectory(outputDir, path.join(outputDir, "sprites.zip"));
}
