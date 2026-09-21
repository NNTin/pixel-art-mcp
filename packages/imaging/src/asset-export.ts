/**
 * All targets (furniture/character/pet) share conversion, frames, diagnostics and previews; only
 * packing differs. Verbatim port of `src/pixel_art_mcp/imaging/asset_export.py` (409 lines) --
 * the real, actually-used-in-production export path (as opposed to the generic
 * downscale/quantize path `pixels.ts::exportSheet`'s fallback branch ports, which the current
 * product surface can't actually reach -- see `docs/architecture.md`'s "Generic MCP rendering
 * has been removed"). Native pixel layers bypass quantization entirely: `compositeFeatures`
 * paints exact palette colors directly onto a full-resolution canvas.
 */

import fs from "node:fs";
import path from "node:path";

import {
  PixelArt,
  type PixelArtDict,
  type AssetLayout as CoreAssetLayout,
} from "@pixel-art-mcp/pixel-core";
import {
  AssetSpecSchema,
  DomainError,
  PixelDefinitionSchema,
  RenderOptionsSchema,
  clipDurationMs,
  clipPlayback,
  renderOptionsFrames,
  type AssetLayout,
  type AssetSpec,
  type RenderOptions,
} from "@pixel-art-mcp/schema";

import { encodeApng } from "./apng.js";
import { BACKGROUND_COLOR, exportContext, luma, type ExportContextMetadata } from "./context.js";
import {
  compositeFeatures,
  largestComponentSize,
  type FeaturePatch,
  type FeatureReport,
} from "./features.js";
import { saveAnimatedGif } from "./gif.js";
import {
  createImage,
  isWithinDirectory,
  pasteFull,
  readPng,
  resizeNearest,
  writePng,
  type RGBAImage,
} from "./image.js";
import { inspectSprite } from "./inspection.js";
import { at, defined } from "./internal.js";
import { zipDirectory } from "./pack-zip.js";
import { exportCharacter } from "./character.js";
import { MAX_PET_PNG_BYTES } from "./pet.js";
import { exportPixelAgents } from "./pixel-agents.js";

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
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

/**
 * Combined schema-level + engine-level port of `validated_art`: `PixelDefinition.from_art` (drop
 * a stray `views` key, then validate) is `packages/schema`'s job; `PixelArt.fromDict` +
 * `.validateTarget` (which checks authored poses actually match the configured canvases and
 * contain visible ink) needs `packages/pixel-core`'s real engine, which `packages/schema` has no
 * dependency on (see that package's own `validatedArt` doc comment). `packages/imaging` already
 * depends on both, so this is the one place that engine-level check gets wired in, matching
 * Python's `validated_art` exactly (one try/catch around every check, one `DomainError` wrapper).
 */
function validatedArt(data: Record<string, unknown>, options: RenderOptions): PixelArt {
  try {
    const { views: _views, ...rest } = data;
    PixelDefinitionSchema.parse(rest);
    const art = PixelArt.fromDict(data as unknown as PixelArtDict);
    const spec = AssetSpecSchema.parse(options.asset);
    if (!options.asset_layouts) {
      throw new Error("Render options are missing asset_layouts");
    }
    art.validateTarget(
      options.asset_layouts as unknown as CoreAssetLayout[],
      renderOptionsFrames(options),
      {
        outline: spec.outline,
        colors: spec.colors,
        palette: spec.palette,
      },
    );
    return art;
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new DomainError(`Invalid pixel-art definition: ${message}`);
  }
}

export interface AssetExportManifestFrame {
  angle: number;
  frame: number;
  filename: string;
  pivot: [number, number];
  pixel_layers: readonly FeaturePatch[];
  [key: string]: unknown;
}

export interface AssetExportManifest {
  pixel_art?: Record<string, unknown> | null;
  frames: readonly AssetExportManifestFrame[];
  camera: Record<string, unknown>;
}

// -----------------------------------------------------------------------------------------------
// package_asset
// -----------------------------------------------------------------------------------------------

export function packageAsset(
  output: string,
  spec: AssetSpec,
  layouts: readonly AssetLayout[],
  cells: ReadonlyMap<string, RGBAImage>,
): Record<string, unknown> {
  const angles = layouts.map((row) => row.angle);
  const firstLayout = defined(layouts[0], "first asset layout");

  if (spec.kind === "furniture") {
    const clipEntries = Object.entries(spec.clips);
    const variants: Record<string, unknown>[] = [];
    for (const [key, clip] of clipEntries) {
      const assetId =
        clipEntries.length > 1
          ? `${String(spec.asset_id)}_${key.toUpperCase()}`
          : String(spec.asset_id);
      const name = clipEntries.length > 1 ? `${spec.name} — ${clip.name ?? key}` : spec.name;
      const options: RenderOptions = RenderOptionsSchema.parse({
        width: firstLayout.width,
        height: firstLayout.height,
        angles,
        frame_sequence: clip.frames,
        pixel_agents: {
          asset_id: assetId,
          name,
          category: spec.category,
          can_place_on_surfaces: spec.placement === "surface",
          can_place_on_walls: spec.placement === "wall",
          background_tiles: firstLayout.background_tiles,
          footprint_w: firstLayout.footprint_w,
          footprint_h: firstLayout.footprint_h,
          off_frame: clip.off_frame,
        },
      });
      const on = angles.flatMap((angle) =>
        clip.frames.map((frame) =>
          defined(cells.get(cellKey(angle, frame)), `on cell ${String(angle)}:${String(frame)}`),
        ),
      );
      const offFrame = clip.off_frame;
      const off =
        offFrame !== null
          ? angles.map((angle) =>
              defined(
                cells.get(cellKey(angle, offFrame)),
                `off cell ${String(angle)}:${String(offFrame)}`,
              ),
            )
          : null;
      const variant = exportPixelAgents(output, options, on, off, layouts);
      if (!variant) throw new DomainError("pixel-agents export produced no result");
      variants.push(variant);
    }
    zipDirectory(path.join(output, "pixel-agents"), path.join(output, "pixel-agents.zip"));
    return { kind: spec.kind, archive: "pixel-agents.zip", variants };
  }

  if (spec.kind === "character") {
    const frames = (["walk", "typing", "reading"] as const).flatMap(
      (key) => defined(spec.clips[key], `character clip ${key}`).frames,
    );
    const options: RenderOptions = RenderOptionsSchema.parse({
      width: 16,
      height: 32,
      angles,
      frame_sequence: frames,
      character: { asset_id: String(spec.asset_id), name: spec.name },
    });
    const cellFrames = angles.flatMap((angle) =>
      frames.map((frame) =>
        defined(
          cells.get(cellKey(angle, frame)),
          `character cell ${String(angle)}:${String(frame)}`,
        ),
      ),
    );
    const target = exportCharacter(output, options, cellFrames);
    return { kind: spec.kind, ...(target ?? {}) };
  }

  // pet
  const directory = path.join(output, "pixel-agents-pet", String(spec.asset_id));
  fs.mkdirSync(directory, { recursive: true });
  const sheet = createImage(96, 96);
  ([0, 180, 90] as const).forEach((angle, row) => {
    const walkFrames = defined(spec.clips["walk"], "pet walk clip").frames;
    const idleFrames = angle !== 90 ? defined(spec.clips["idle"], "pet idle clip").frames : [];
    const frames = [...walkFrames, ...idleFrames];
    const width = angle === 90 ? 32 : 16;
    frames.forEach((frame, column) => {
      pasteFull(
        sheet,
        defined(cells.get(cellKey(angle, frame)), `pet cell ${String(angle)}:${String(frame)}`),
        column * width,
        row * 32,
      );
    });
  });
  const petPngPath = path.join(directory, "pet.png");
  writePng(petPngPath, sheet);
  if (fs.statSync(petPngPath).size > MAX_PET_PNG_BYTES) {
    throw new DomainError("Pet PNG exceeds the consumer's 512 KiB limit");
  }
  writeJson(path.join(directory, "manifest.json"), { id: spec.asset_id, name: spec.name });
  zipDirectory(path.join(output, "pixel-agents-pet"), path.join(output, "pixel-agents-pet.zip"));
  return {
    kind: spec.kind,
    archive: "pixel-agents-pet.zip",
    image: `pixel-agents-pet/${String(spec.asset_id)}/pet.png`,
  };
}

// -----------------------------------------------------------------------------------------------
// asset_report
// -----------------------------------------------------------------------------------------------

interface CameraView {
  angle: number;
  objects: { name: string; pixel_width: number; pixel_height: number; [key: string]: unknown }[];
}

export interface AssetReportMetadata {
  asset: {
    kind: string;
    clips: Record<string, { frames: readonly number[]; off_frame?: number | null }>;
  };
  layouts: readonly AssetLayout[];
  frames: readonly {
    angle: number;
    frame: number;
    filename: string;
    pixel_features?: readonly FeatureReport[];
  }[];
  directions: readonly { angle: number }[];
  configuration_id: string | null;
  camera: { views?: readonly CameraView[] };
  package: { archive: string };
}

export function assetReport(
  output: string,
  metadata: AssetReportMetadata,
): Record<string, unknown> {
  const spec = metadata.asset;
  const reports: Record<string, unknown>[] = [];
  const findings: Record<string, unknown>[] = [];
  const layouts = new Map<number, AssetLayout>();
  for (const row of metadata.layouts) layouts.set(row.angle, row);

  for (const entry of metadata.frames) {
    const clipMatch = Object.entries(spec.clips).find(
      ([, clip]) => clip.frames.includes(entry.frame) || clip.off_frame === entry.frame,
    );
    const clipId = defined(clipMatch, `clip for frame ${String(entry.frame)}`)[0];
    const inspected = inspectSprite(output, clipId, entry.angle, entry.frame);
    const analysis = inspected.analysis;
    const bounds = analysis.occupied_bounds;
    const [width, height] = inspected.size;
    if (!bounds) {
      throw new DomainError(
        `Empty sprite at angle ${String(entry.angle)}, frame ${String(entry.frame)}; enlarge geometry`,
      );
    }
    const [x, y, w, h] = bounds;
    const layout = defined(layouts.get(entry.angle), `layout for angle ${String(entry.angle)}`);
    reports.push({
      angle: entry.angle,
      frame: entry.frame,
      size: [width, height],
      occupied_bounds: bounds,
      occupied_pixels: analysis.occupied_pixels,
      margins: { left: x, top: y, right: width - x - w, bottom: height - y - h },
      bottom_gap: height - y - h,
      contact_offset: layout.bottom - y - h,
      center_offset: Math.round((x + w / 2 - width / 2) * 100) / 100,
      singleton_color_clusters: analysis.color_singleton_components,
      opaque_connected_components: analysis.opaque_connected_components,
      opaque_singleton_components: analysis.opaque_singleton_components,
      color_components: analysis.color_components,
      pixel_features: entry.pixel_features ?? [],
    });
    if (analysis.opaque_connected_components > 1) {
      findings.push({
        code: "disconnected_silhouette",
        angle: entry.angle,
        frame: entry.frame,
        components: analysis.opaque_connected_components,
        suggestion:
          "Review detached regions in the preview. Connect structural parts such as posts, " +
          "platforms and bases; intentional detached effects can remain. Four-neighbor " +
          "connectivity does not count diagonal contact.",
      });
    }
    for (const feature of entry.pixel_features ?? []) {
      for (const code of feature.issues) {
        findings.push({
          code,
          angle: entry.angle,
          frame: entry.frame,
          feature: feature.name,
          suggestion: "Revise the feature shape, offset or layer order.",
        });
      }
    }
    const image = readPng(path.join(output, entry.filename));
    const backgroundLuma = luma(BACKGROUND_COLOR);
    let opaqueCount = 0;
    const similarPoints = new Set<string>();
    const total = image.width * image.height;
    for (let index = 0; index < total; index++) {
      const offset = index * 4;
      const alpha = image.data[offset + 3] ?? 0;
      if (!alpha) continue;
      opaqueCount += 1;
      const rgb: [number, number, number] = [
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      ];
      if (Math.abs(luma(rgb) - backgroundLuma) < 16) {
        similarPoints.add(
          `${String(index % image.width)},${String(Math.floor(index / image.width))}`,
        );
      }
    }
    // A sprite can stay under the overall-similarity ratio yet still read as broken if one solid
    // patch (not just scattered dark pixels) merges into the floor -- e.g. a single oversized
    // dark fill -- so check both.
    if (
      opaqueCount > 0 &&
      (similarPoints.size / opaqueCount > 0.85 ||
        largestComponentSize(similarPoints) / opaqueCount > 0.4)
    ) {
      findings.push({
        code: "low_context_contrast",
        angle: entry.angle,
        frame: entry.frame,
        suggestion:
          "Most pixels blend into the dark preview floor; brighten broad materials or add an outline.",
      });
    }
    if (analysis.occupied_pixels < 12 || w < 3 || h < 3) {
      findings.push({
        code: "small_silhouette",
        angle: entry.angle,
        frame: entry.frame,
        suggestion: "Increase the useful pixel area or exaggerate slender geometry.",
      });
    }
    if (analysis.color_singleton_components > Math.max(12, analysis.occupied_pixels * 0.4)) {
      findings.push({
        code: "fragmented_colors",
        angle: entry.angle,
        frame: entry.frame,
        suggestion: "Simplify materials/details or reduce colors.",
      });
    }
  }

  const animation: Record<string, unknown>[] = [];
  const byKey = new Map<string, AssetReportMetadata["frames"][number]>();
  for (const entry of metadata.frames) byKey.set(cellKey(entry.angle, entry.frame), entry);
  for (const [clipId, clip] of Object.entries(spec.clips)) {
    for (const direction of metadata.directions) {
      const angle = direction.angle;
      const images = clip.frames.map((frame) =>
        readPng(
          path.join(
            output,
            defined(byKey.get(cellKey(angle, frame)), `animation frame ${String(frame)}`).filename,
          ),
        ),
      );
      const rotated = [...images.slice(1), ...images.slice(0, 1)];
      const changes = images.map((a, index) => {
        const b = at(rotated, index);
        let count = 0;
        const pixels = a.width * a.height;
        for (let p = 0; p < pixels; p++) {
          const o = p * 4;
          if (
            a.data[o] !== b.data[o] ||
            a.data[o + 1] !== b.data[o + 1] ||
            a.data[o + 2] !== b.data[o + 2] ||
            a.data[o + 3] !== b.data[o + 3]
          ) {
            count++;
          }
        }
        return count;
      });
      animation.push({ clip: clipId, angle, changed_pixels: changes });
      if (images.length > 1 && Math.max(...changes) < 2) {
        findings.push({
          code: "static_animation",
          clip: clipId,
          angle,
          suggestion: "Exaggerate the animated part if visible motion is intended.",
        });
      }
    }
  }

  const features: Record<string, unknown>[] = [];
  for (const view of metadata.camera.views ?? []) {
    for (const obj of view.objects) features.push({ angle: view.angle, ...obj });
  }
  const thin = features.filter(
    (f) => Math.min(f["pixel_width"] as number, f["pixel_height"] as number) < 2,
  );

  return {
    status: findings.length > 0 ? "review" : "checks_passed",
    visual_review_required: true,
    kind: spec.kind,
    configuration_id: metadata.configuration_id,
    frames: reports,
    layouts: metadata.layouts,
    animation,
    findings,
    projected_objects: features,
    thin_objects: thin,
    notes: [
      "Projected object bounds do not establish visibility or occlusion.",
      "Readability is advisory; review contextual previews and the exact pixel grid.",
      "Framing is fixed across clips; intentional motion is not re-centered per frame.",
    ],
    outputs: {
      preview: "preview.html",
      context: "context.png",
      package: metadata.package.archive,
    },
  };
}

// -----------------------------------------------------------------------------------------------
// export_asset
// -----------------------------------------------------------------------------------------------

export function exportAsset(
  rawDir: string,
  output: string,
  manifest: AssetExportManifest,
  optionsInput: RenderOptions,
  projectId: string,
  revisionId: string,
): void {
  const spec = optionsInput.asset;
  const layoutsRaw = optionsInput.asset_layouts;
  if (!spec || !layoutsRaw) {
    throw new DomainError("Render options are missing asset/asset_layouts");
  }
  if (!manifest.pixel_art) {
    throw new DomainError("Render output has no required pixel-art definition");
  }
  const art = validatedArt(manifest.pixel_art, optionsInput);
  const palette = Object.values(art.palette);
  const options: RenderOptions = { ...optionsInput, palette };
  const layouts = layoutsRaw as unknown as AssetLayout[];

  const entries = manifest.frames;
  const framesList = renderOptionsFrames(options);
  const expected: [number, number][] = [];
  for (const row of layouts) for (const f of framesList) expected.push([row.angle, f]);
  const actual: [number, number][] = entries.map((e) => [e.angle, e.frame]);
  if (!sameSequence(actual, expected)) {
    throw new DomainError("Render output has incomplete or unordered asset frames");
  }

  const byAngle = new Map<number, AssetLayout>();
  for (const row of layouts) byAngle.set(row.angle, row);
  const sizes: [number, number][] = entries.map((entry) => {
    const row = defined(byAngle.get(entry.angle), `layout for angle ${String(entry.angle)}`);
    return [row.width, row.height];
  });

  const resolvedRawDir = path.resolve(rawDir);
  const sources: RGBAImage[] = entries.map((entry, index) => {
    const size = at(sizes, index);
    const resolvedPath = path.resolve(rawDir, entry.filename);
    if (!isWithinDirectory(resolvedRawDir, resolvedPath) || path.extname(resolvedPath) !== ".png") {
      throw new DomainError("Invalid render output image path");
    }
    const opened = readPng(resolvedPath);
    if (
      opened.width !== size[0] * options.supersampling ||
      opened.height !== size[1] * options.supersampling
    ) {
      throw new DomainError("Render output has wrong asset canvas dimensions");
    }
    return opened;
  });

  const rendered: RGBAImage[] = sizes.map((size) => createImage(size[0], size[1]));
  const updatedEntries: AssetExportManifestFrame[] = entries.map((entry, index) => {
    const { image, reports } = compositeFeatures(
      at(rendered, index),
      entry.pixel_layers,
      art.palette,
    );
    rendered[index] = image;
    const previousSource = at(sources, index);
    sources[index] = resizeNearest(image, previousSource.width, previousSource.height);
    return { ...entry, pixel_features: reports };
  });

  const cells = new Map<string, RGBAImage>();
  updatedEntries.forEach((entry, index) =>
    cells.set(cellKey(entry.angle, entry.frame), at(rendered, index)),
  );

  fs.mkdirSync(output, { recursive: true });
  writeJson(path.join(output, "pixel-art.json"), art.toDict());
  fs.mkdirSync(path.join(output, "frames"), { recursive: true });
  fs.mkdirSync(path.join(output, "comparison"), { recursive: true });

  const maxWidth = Math.max(...sizes.map((s) => s[0]));
  const maxHeight = Math.max(...sizes.map((s) => s[1]));
  const columns = framesList.length;
  const sheet = createImage(maxWidth * columns, maxHeight * layouts.length);
  const highSheet = createImage(
    sheet.width * options.supersampling,
    sheet.height * options.supersampling,
  );

  const frameMetadata: Record<string, unknown>[] = updatedEntries.map((entry, index) => {
    const im = at(rendered, index);
    const source = at(sources, index);
    const row = Math.floor(index / columns);
    const column = index % columns;
    const name = `frames/direction_${pad(row, 2)}_frame_${pad(entry.frame, 6)}.png`;
    const highName = `comparison/${path.basename(name)}`;
    writePng(path.join(output, name), im);
    writePng(path.join(output, highName), source);
    const x = column * maxWidth;
    const y = row * maxHeight;
    pasteFull(sheet, im, x, y);
    pasteFull(highSheet, source, x * options.supersampling, y * options.supersampling);
    return { ...entry, filename: name, source: highName, rect: [x, y, im.width, im.height] };
  });
  writePng(path.join(output, "spritesheet.png"), sheet);
  writePng(path.join(output, "comparison/high-resolution.png"), highSheet);
  const previewScale = Math.min(
    4,
    Math.max(1, Math.floor(1024 / Math.max(sheet.width, sheet.height))),
  );
  writePng(
    path.join(output, "preview.png"),
    resizeNearest(sheet, sheet.width * previewScale, sheet.height * previewScale),
  );

  fs.mkdirSync(path.join(output, "animations"), { recursive: true });
  const animationFiles: string[] = [];
  for (const [key, clip] of Object.entries(spec.clips)) {
    if (clip.frames.length < 2) continue;
    for (const angle of byAngle.keys()) {
      const sourceAngle = spec.kind === "pet" && key === "idle" && angle === 90 ? 0 : angle;
      const sequence = clipPlayback(spec.kind, key, clip).map((frame) =>
        defined(
          cells.get(cellKey(sourceAngle, frame)),
          `animation cell ${String(sourceAngle)}:${String(frame)}`,
        ),
      );
      const name = `animations/${key}_${pad(angle, 3)}.apng`;
      const apng = encodeApng(sequence, {
        delayMs: clipDurationMs(spec.kind, key),
        disposeOp: 0,
        blendOp: 0,
      });
      fs.writeFileSync(path.join(output, name), apng);
      animationFiles.push(name);
    }
  }
  if (animationFiles.length > 0) {
    const firstAnimated = Object.entries(spec.clips).find(([, clip]) => clip.frames.length > 1);
    if (firstAnimated) {
      const [firstKey, firstClip] = firstAnimated;
      const firstLayout = defined(layouts[0], "first layout");
      const gifFrames = clipPlayback(spec.kind, firstKey, firstClip).map((frame) => {
        const cell = defined(
          cells.get(cellKey(firstLayout.angle, frame)),
          `gif cell ${String(frame)}`,
        );
        return resizeNearest(cell, firstLayout.width * 4, firstLayout.height * 4);
      });
      saveAnimatedGif(
        gifFrames,
        palette,
        1000 / clipDurationMs(spec.kind, firstKey),
        path.join(output, "preview.gif"),
      );
    }
  }

  const packageInfo = packageAsset(output, spec, layouts, cells);
  const metadata = {
    schema_version: 1,
    pixel_art: "pixel-art.json",
    project_id: projectId,
    revision_id: revisionId,
    configuration_id: options.asset_configuration_id,
    asset: spec,
    settings: options,
    layouts,
    palette,
    image: "spritesheet.png",
    size: [sheet.width, sheet.height],
    frames: frameMetadata,
    directions: layouts.map((row) => ({ angle: row.angle })),
    package: packageInfo,
    camera: manifest.camera,
    animations: animationFiles,
    playback: Object.fromEntries(
      Object.entries(spec.clips).map(([key, clip]) => [
        key,
        { frames: clipPlayback(spec.kind, key, clip), duration_ms: clipDurationMs(spec.kind, key) },
      ]),
    ),
    player: "preview.html",
  };
  writeJson(path.join(output, "spritesheet.json"), metadata);
  writeJson(path.join(output, "asset-specification.json"), spec);
  writeJson(
    path.join(output, "asset-report.json"),
    assetReport(output, metadata as unknown as AssetReportMetadata),
  );
  exportContext(output, metadata as unknown as ExportContextMetadata);
  zipDirectory(output, path.join(output, "sprites.zip"));
}
