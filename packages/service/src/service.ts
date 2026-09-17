/**
 * Port of `Service` in `src/pixel_art_mcp/projects/service.py` (542 lines): the orchestration
 * layer binding project/revision/asset-configuration management, reference ingestion (Phase 6a),
 * and job submission/lifecycle together. The other half of this phase -- the real `JobExecutor`
 * that actually runs a claimed job (Python's `Worker.execute()`) -- lives in `job-executor.ts`
 * and is deliberately *not* a method on this class, matching `packages/jobs`' pluggable-executor
 * seam (see that package's `worker.ts` doc comment): `Service` only ever *enqueues* work and
 * *reads back* job/revision state, it never runs a job itself.
 *
 * **Worker coupling, adapted for the new pluggable design.** Python's `Service` and `Worker` hold
 * direct references to each other (`Worker(service)`; `service.worker_ready`/`service.wake`).
 * `packages/jobs`' `Worker` takes a `{ store, execute }` pair instead of a `Service` (Phase 4's
 * deliberate decoupling), so this port inverts the wiring: whoever constructs both (today, tests
 * in this package; `apps/server` in Phase 7) calls `service.attachWorker(worker)` after
 * constructing the `Worker` with `createJobExecutor(service)` as its executor. `workerReady`/
 * `wake()` read/drive the attached `Worker`'s own `isReady`/`wake()`; `cancelJob` delegates a
 * running job's cancellation to the attached `Worker.cancel(jobId)` rather than Python's own
 * `cancel_events` dict, since `packages/jobs`' `Worker` already owns exactly that per-job
 * `AbortController` bookkeeping -- duplicating it here would just be two sources of truth.
 */

import fs from "node:fs";
import path from "node:path";

import type { PixelArtDict } from "@pixel-art-mcp/pixel-core";
import {
  AUTHORING_VERSION,
  ArtifactSchema,
  AssetSpecSchema,
  DomainError,
  JobSchema,
  PixelArtSourceSchema,
  PixelDefinitionSchema,
  ProjectDetailSchema,
  ProjectSchema,
  ReferenceSchema,
  RevisionSchema,
  applyPixelEdits,
  getAssetProfile,
  normalizeAsset,
  renderOptionsRenderFrames,
  resolveAsset,
  type AssetLayout,
  type AssetSpec,
  type Artifact,
  type Job,
  type OpenAIFile,
  type PixelDefinition,
  type PixelArtSource,
  type PixelEdits,
  type Project,
  type ProjectDetail,
  type Reference,
  type RenderOptions,
} from "@pixel-art-mcp/schema";
import { Store, identifier, timestamp, type RecordPayload } from "@pixel-art-mcp/storage";

import {
  MAX_ARTIFACT_CHUNK_BYTES,
  MAX_INLINE_ARTIFACT_BYTES,
  readArtifactChunk,
  type ArtifactChunk,
} from "./artifacts.js";
import { condenseLog } from "./log-condense.js";
import { guessMediaType } from "./media-type.js";
import { buildSaveScript, definitionToArt, validateAuthoredArt } from "./pixel-authoring.js";
import { downloadReference, normalizeReference } from "./references.js";
import { DEFAULT_SERVICE_SETTINGS, type ServiceSettings } from "./settings.js";

// Kept for parity with Python's `pixel_art_mcp.__version__` (`pyproject.toml`'s `version = "0.1.0"`).
// Flagged: `apps/server` (Phase 7) should source this from a real package version once one exists
// for the published app, rather than this hardcoded literal.
const SERVICE_VERSION = "0.1.0";

/** What `Service.attachWorker` needs from a `packages/jobs` `Worker` -- see this file's top
 * comment. A structural interface (not an import of `Worker` itself) so this package doesn't
 * need to depend on any particular `Worker` implementation detail beyond its public surface. */
export interface WorkerHandle {
  readonly isReady: boolean;
  wake: () => void;
  cancel: (jobId: string) => boolean;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function decodeStrictBase64(value: string): Uint8Array {
  // Approximates Python's `base64.b64decode(data_base64, validate=True)`: reject any character
  // outside the base64 alphabet and wrong padding/length, unlike `Buffer.from(str, "base64")`
  // (which silently skips invalid characters). Not a byte-for-byte port of CPython's decoder --
  // flagged here the same way `packages/schema`'s UUID-pattern note flags its own approximation.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Invalid base64 input");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export class Service {
  readonly settings: ServiceSettings;
  readonly store: Store;
  private worker: WorkerHandle | null = null;

  constructor(settings: Partial<ServiceSettings> & { data_dir: string }) {
    this.settings = { ...DEFAULT_SERVICE_SETTINGS, ...settings };
    this.store = new Store(this.settings.data_dir);
  }

  /** See this file's top comment for why `Service`/`Worker` are wired together this way. */
  attachWorker(worker: WorkerHandle): void {
    this.worker = worker;
  }

  get workerReady(): boolean {
    return this.worker?.isReady ?? false;
  }

  /** Wakes the attached worker, if any -- called after every successful job submission. */
  private wake(): void {
    this.worker?.wake();
  }

  capabilities(): Record<string, unknown> {
    const limits: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.settings)) {
      if (key.startsWith("max_") || key.endsWith("timeout")) {
        limits[key] = value;
      }
    }
    Object.assign(limits, {
      max_pixel_layers: 128,
      max_poses_per_layer: 256,
      max_authored_cells: 262_144,
      max_preview_pixels: 4_194_304,
      max_inline_artifact_bytes: MAX_INLINE_ARTIFACT_BYTES,
      max_artifact_chunk_bytes: MAX_ARTIFACT_CHUNK_BYTES,
      max_pixel_edit_operations: 128,
      max_drawing_commands_per_pose: 256,
      max_drawing_repetitions: 128,
      max_drawing_paint_operations: 1_048_576,
    });

    const assetProfiles: Record<string, unknown> = {};
    for (const kind of ["furniture", "character", "pet"] as const) {
      const profile = getAssetProfile(kind) as { presets: unknown };
      assetProfiles[kind] = { presets: profile.presets, tool: "get_asset_profile" };
    }

    return {
      schema_version: 1,
      version: SERVICE_VERSION,
      pixel_authoring_required: true,
      authoring_contract_version: AUTHORING_VERSION,
      // Flagged gap: no MCP SDK dependency exists yet (apps/server is Phase 7) -- Python reads
      // `importlib.metadata.version("mcp")` here, which has no meaningful TS equivalent until
      // that dependency exists.
      mcp_sdk_version: "not-yet-integrated",
      worker_ready: this.workerReady,
      transport: "streamable-http",
      authentication: "none",
      modeling: "write_pixel_art accepts typed pixel data; helpers run on the server",
      asset_workflow: [
        "get_asset_profile",
        "create_project",
        "configure_asset",
        "write_pixel_art",
        "wait_for_job",
        "get_pixel_art",
        "render_asset",
        "wait_for_job",
        "inspect_asset",
        "inspect_sprite",
        "get_asset_preview",
      ],
      pixel_editing: {
        tool: "edit_pixel_art",
        operations: ["move_pose", "set_pose", "delete_pose", "set_layer", "delete_layer", "set_palette"],
        atomic: true,
        expected_revision_required: true,
      },
      artifact_delivery: {
        inline_tool: "get_artifact",
        binary_content:
          "Embedded base64 blob resources up to max_inline_artifact_bytes; no resources/read required",
        chunk_tool: "get_artifact_chunk",
        chunk_encoding:
          "Decode each base64 chunk separately, concatenate raw bytes by offset; next_offset=null ends the file",
        download_base_url: trimTrailingSlashes(this.settings.base_url),
        local_saving: "Client attachment/download integration required; no arbitrary filesystem writes",
      },
      asset_profiles: assetProfiles,
      export_features: {
        preview_options: "get_asset_preview selects clip, angle, frame, scale and context via MCP",
        animation_format: "image/apng",
        animation_layout: "one transparent loop per direction, at export resolution",
        offline_player: "preview.html; play/pause, scrub, zoom, background",
        sizing: "Native canvases and rotated footprints from configure_asset",
        pixel_agents:
          "Required target manifest + PNG package; furniture uses 5 fps, off/on states. Animation only runs near an active agent, as supported by the app.",
        comparison: "Authored grid or unmodified source render beside final sprites",
        text_inspection:
          "Palette-index grid, color/cluster metrics, and comparison for agents without image or vision support",
        downscaling:
          "One shared palette and local alpha-weighted color voting; native pixel layers bypass conversion entirely",
        pixel_layers:
          "Named per-view/per-frame layers saved in scene revisions; optional projected object anchors; final visibility and connectivity checks",
        states:
          "Named states share framing/palette; one generated HTML comparison player and one pixel-agents ZIP containing separate selectable variants.",
      },
      limits,
    };
  }

  createProject(name: string): Project {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) {
      throw new DomainError("Project name must contain 1–120 characters");
    }
    return ProjectSchema.parse(this.store.createProject(trimmed));
  }

  listProjects(): Project[] {
    return this.store.projects().map((row) => ProjectSchema.parse(row));
  }

  getProject(projectId: string): ProjectDetail {
    return ProjectDetailSchema.parse({
      project: ProjectSchema.parse(this.store.project(projectId)),
      references: this.store.records(projectId, "reference").map((r) => ReferenceSchema.parse(r)),
      revisions: this.store.records(projectId, "revision").map((r) => RevisionSchema.parse(r)),
      asset_configuration: this.assetConfiguration(projectId),
    });
  }

  assetConfiguration(projectId: string): RecordPayload | null {
    this.store.project(projectId);
    const records = this.store.records(projectId, "asset_configuration");
    if (records.length === 0) return null;
    return records.reduce((latest, record) =>
      (record["created_at"] as string) > (latest["created_at"] as string) ? record : latest,
    );
  }

  configureAsset(projectId: string, specification: AssetSpec): RecordPayload {
    this.store.project(projectId);
    const normalized = normalizeAsset(specification);
    const resolved = resolveAsset(normalized);
    const record: RecordPayload = {
      id: identifier(),
      project_id: projectId,
      created_at: timestamp(),
      specification: normalized,
      layouts: resolved.asset_layouts,
    };
    this.store.putRecord("asset_configuration", record);
    return record;
  }

  renderAsset(projectId: string, revisionId: string | null = null): Job {
    const configuration = this.assetConfiguration(projectId);
    if (configuration === null) {
      throw new DomainError("Call configure_asset before render_asset");
    }
    const options = resolveAsset(
      AssetSpecSchema.parse(configuration["specification"]),
      configuration.id,
    );
    return this.submitRender(projectId, options, revisionId);
  }

  writePixelArt(
    projectId: string,
    definition: PixelDefinition,
    expectedRevisionId: string | null,
  ): Job {
    const configuration = this.assetConfiguration(projectId);
    if (configuration === null) {
      throw new DomainError("Call configure_asset before write_pixel_art");
    }
    const options = resolveAsset(
      AssetSpecSchema.parse(configuration["specification"]),
      configuration.id,
    );
    if (!options.asset_layouts) {
      throw new Error("Invariant violated: resolveAsset produced no asset_layouts");
    }
    let data: PixelArtDict;
    try {
      data = definitionToArt(definition, options.asset_layouts as unknown as AssetLayout[]).toDict();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      throw new DomainError(`Invalid pixel-art definition: ${message}`);
    }
    validateAuthoredArt(data as unknown as Record<string, unknown>, options);
    const script = buildSaveScript(data);
    return this.submitScript(projectId, script, expectedRevisionId, true);
  }

  getPixelArt(projectId: string, revisionId: string | null = null): PixelArtSource {
    const revision = this.revision(projectId, revisionId);
    const summary = revision["summary"] as Record<string, unknown>;
    const data = summary["pixel_art"] as Record<string, unknown> | null | undefined;
    if (data === null || data === undefined) {
      throw new DomainError("Revision has no pixel art; call write_pixel_art", 409);
    }
    const configuration = this.assetConfiguration(projectId);
    const { views: _views, ...rest } = data;
    const definition = PixelDefinitionSchema.parse(rest);
    return PixelArtSourceSchema.parse({
      project_id: projectId,
      revision_id: revision.id,
      definition,
      authored_views: data["views"],
      configuration_id: configuration ? (configuration.id) : null,
    });
  }

  editPixelArt(projectId: string, edits: PixelEdits, expectedRevisionId: string): Job {
    if (this.store.project(projectId).current_revision_id !== expectedRevisionId) {
      throw new DomainError("Scene revision changed; get_pixel_art and retry with its current ID", 409);
    }
    const source = this.getPixelArt(projectId, expectedRevisionId);
    let definition: PixelDefinition;
    try {
      definition = applyPixelEdits(source.definition, edits);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      throw new DomainError(`Invalid pixel edit: ${message}`);
    }
    return this.writePixelArt(projectId, definition, expectedRevisionId);
  }

  exportRoot(jobId: string): string {
    const job = this.job(jobId);
    if (job.status !== "succeeded" || (job.operation !== "preview" && job.operation !== "sprites")) {
      throw new DomainError("Inspection requires a succeeded render job");
    }
    const paths = job.artifacts
      .filter((artifact) => artifact.filename === "sprites.zip")
      .map((artifact) => this.artifactPath(artifact.id));
    if (paths.length === 0) {
      throw new DomainError("Render has no sprites.zip artifact");
    }
    const shallowest = paths.reduce((best, candidate) =>
      candidate.split(path.sep).length < best.split(path.sep).length ? candidate : best,
    );
    return path.dirname(shallowest);
  }

  inspectAsset(jobId: string): Record<string, unknown> {
    const reportPath = path.join(this.exportRoot(jobId), "asset-report.json");
    if (!fs.existsSync(reportPath) || !fs.statSync(reportPath).isFile()) {
      throw new DomainError("This legacy render has no asset report; use configure_asset/render_asset");
    }
    return { job_id: jobId, ...(JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>) };
  }

  artifactRecord(
    projectId: string,
    filePath: string,
    kind: string,
    jobId: string | null = null,
    width: number | null = null,
    height: number | null = null,
  ): RecordPayload {
    const resolved = path.resolve(filePath);
    const relative = path.relative(this.store.root, resolved);
    const checkedPath = this.store.path(relative);
    const exportPath = jobId
      ? path
          .relative(path.join(this.store.root, "projects", projectId, "jobs", jobId), resolved)
          .split(path.sep)
          .join("/")
      : path.basename(resolved);
    return {
      id: identifier(),
      project_id: projectId,
      job_id: jobId,
      kind,
      filename: path.basename(resolved),
      relative_path: relative,
      export_path: exportPath,
      media_type: guessMediaType(resolved),
      size_bytes: fs.statSync(checkedPath).size,
      width,
      height,
    };
  }

  artifact(artifactId: string): Artifact {
    const record = this.store.record(artifactId, "artifact");
    const rest: Record<string, unknown> = { ...record };
    delete rest["relative_path"];
    rest["download_url"] = `${trimTrailingSlashes(this.settings.base_url)}/artifacts/${artifactId}`;
    return ArtifactSchema.parse(rest);
  }

  artifactPath(artifactId: string): string {
    const record = this.store.record(artifactId, "artifact");
    const resolved = this.store.path(record["relative_path"] as string);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new DomainError("Artifact file is missing", 404);
    }
    return resolved;
  }

  async readArtifactChunk(artifactId: string, offset: unknown, length: unknown): Promise<ArtifactChunk> {
    const artifact = this.artifact(artifactId);
    const filePath = this.artifactPath(artifactId);
    return readArtifactChunk(filePath, artifact, offset, length);
  }

  reference(referenceId: string): Reference {
    return ReferenceSchema.parse(this.store.record(referenceId, "reference"));
  }

  async addReference(projectId: string, data: Uint8Array, filename: string): Promise<Reference> {
    this.store.project(projectId);
    const referenceId = identifier();
    const directory = this.store.path(`projects/${projectId}/references/${referenceId}`);
    try {
      const info = await normalizeReference(data, directory, {
        maxUploadBytes: this.settings.max_upload_bytes,
        maxImagePixels: this.settings.max_image_pixels,
      });
      const original = this.artifactRecord(
        projectId,
        path.join(directory, `original.${info.extension}`),
        "reference",
      );
      const image = this.artifactRecord(
        projectId,
        path.join(directory, "image.png"),
        "reference_image",
        null,
        info.width,
        info.height,
      );
      const thumbnail = this.artifactRecord(projectId, path.join(directory, "thumbnail.png"), "thumbnail");
      const trimmedName = path.basename(filename).slice(0, 255) || "reference.png";
      const reference = ReferenceSchema.parse({
        id: referenceId,
        project_id: projectId,
        filename: trimmedName,
        width: info.width,
        height: info.height,
        sha256: info.sha256,
        original_artifact_id: original.id,
        image_artifact_id: image.id,
        thumbnail_artifact_id: thumbnail.id,
        image_path: path.join(directory, "image.png"),
      });
      this.store.runInTransaction(() => {
        for (const artifact of [original, image, thumbnail]) {
          this.store.putRecord("artifact", artifact);
        }
        this.store.putRecord("reference", reference);
      });
      return reference;
    } catch (error) {
      if (fs.existsSync(directory)) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async addReferenceInput(
    projectId: string,
    dataBase64: string | null,
    file: OpenAIFile | null,
    filename: string,
  ): Promise<Reference> {
    this.store.project(projectId);
    if ((dataBase64 === null) === (file === null)) {
      throw new DomainError("Provide exactly one of data_base64 or file");
    }
    let data: Uint8Array;
    let resolvedFilename = filename;
    if (file !== null) {
      data = await downloadReference(file.download_url, {
        maxUploadBytes: this.settings.max_upload_bytes,
        maxImagePixels: this.settings.max_image_pixels,
      });
      resolvedFilename = file.file_name || filename;
    } else {
      if (dataBase64 === null) {
        throw new Error("Invariant violated: dataBase64 is null");
      }
      if (dataBase64.length > 4 * Math.floor((this.settings.max_upload_bytes + 2) / 3)) {
        throw new DomainError("Reference exceeds the upload size limit", 413);
      }
      try {
        data = decodeStrictBase64(dataBase64);
      } catch {
        throw new DomainError("Invalid base64 image");
      }
    }
    return this.addReference(projectId, data, resolvedFilename);
  }

  revision(projectId: string, revisionId: string | null = null): RecordPayload {
    const project = this.store.project(projectId);
    const resolvedId = revisionId ?? project.current_revision_id;
    if (resolvedId === null) {
      throw new DomainError("Project has no revision; call configure_asset then write_pixel_art", 409);
    }
    const revision = this.store.record(resolvedId, "revision");
    if (revision.project_id !== projectId) {
      throw new DomainError("Revision does not belong to this project", 404);
    }
    return revision;
  }

  submitScript(
    projectId: string,
    script: string,
    expectedRevisionId: string | null,
    requirePixelArt = false,
  ): Job {
    const project = this.store.project(projectId);
    if (expectedRevisionId !== project.current_revision_id) {
      throw new DomainError("Scene revision changed; get_project and retry with its current ID", 409);
    }
    if (!script.trim() || Buffer.byteLength(script, "utf8") > this.settings.max_script_bytes) {
      throw new DomainError("Script is empty or exceeds the script size limit");
    }
    // Flagged deviation: Python does a cheap up-front `compile(script, "submitted.py", "exec")`
    // syntax-only check here, turning a syntax error into an immediate `DomainError` instead of a
    // queued job failure. TypeScript has no equivalent cheap syntax-only pass -- the real
    // type-check/compile step lives inside `packages/engine`'s `script-runtime.ts`, unexported and
    // scoped to running *inside* the job subprocess (it writes scratch files under that package's
    // own directory tree so Node's module resolution finds `@pixel-art-mcp/pixel-core`). Exposing
    // and re-running that compiler here, outside the subprocess sandbox, felt like overreach for
    // this integration phase, so this port intentionally skips the pre-check: a script that fails
    // to compile is instead surfaced as a job failure (`ScriptCompileError`'s message, including
    // every diagnostic) once the engine subprocess actually runs it -- one poll cycle later than
    // Python's synchronous rejection, but with an equally clear diagnostic.
    const configuration = this.assetConfiguration(projectId);
    const options = configuration
      ? resolveAsset(AssetSpecSchema.parse(configuration["specification"]), configuration.id)
      : null;
    let required = requirePixelArt;
    if (expectedRevisionId) {
      const rev = this.revision(projectId, expectedRevisionId);
      const summary = rev["summary"] as Record<string, unknown>;
      required = required || Boolean(summary["pixel_art"]);
    }
    return this._submit(projectId, "script", expectedRevisionId, {
      script,
      pixel_art_required: required,
      authoring_options: options,
    });
  }

  submitRender(
    projectId: string,
    options: RenderOptions,
    revisionId: string | null = null,
    preview = false,
  ): Job {
    if (options.asset === null) {
      throw new DomainError("Generic rendering is unavailable; use configure_asset and render_asset");
    }
    const revision = this.revision(projectId, revisionId);
    const summary = revision["summary"] as Record<string, unknown>;
    const definition = summary["pixel_art"];
    if (definition === null || definition === undefined) {
      throw new DomainError("Pixel art is required; call write_pixel_art before render_asset", 409);
    }
    validateAuthoredArt(definition as Record<string, unknown>, options);

    const frameCount = renderOptionsRenderFrames(options).length * options.angles.length;
    if (frameCount > this.settings.max_render_frames) {
      throw new DomainError("Render exceeds the configured total frame limit");
    }
    // Python computes an intermediate `output_count` from `options.states` first, then always
    // overwrites it from `options.asset.clips` -- since `submit_render` requires `options.asset`
    // (checked above), that first computation is dead code in the Python source too. Ported
    // straight to the asset-based computation to satisfy strict-mode's "always truthy" check on
    // an `if (options.asset)` that's guaranteed true at this point, rather than reproducing dead
    // code literally.
    const outputCount =
      Object.values(options.asset.clips).reduce(
        (sum, clip) => sum + clip.frames.length + (clip.off_frame !== null ? 1 : 0),
        0,
      ) * options.angles.length;
    const pixelCount = Math.max(frameCount, outputCount) * options.width * options.height;
    if (pixelCount > this.settings.max_sheet_pixels) {
      throw new DomainError("Sprite sheet exceeds the configured pixel limit");
    }
    if (pixelCount * options.supersampling ** 2 > this.settings.max_sheet_pixels) {
      throw new DomainError(
        "High-resolution comparison exceeds the configured pixel limit; reduce dimensions, frames, angles, or supersampling",
      );
    }
    return this._submit(projectId, preview ? "preview" : "sprites", revision.id, {
      options,
    });
  }

  private _submit(
    projectId: string,
    operation: "script" | "preview" | "sprites",
    revisionId: string | null,
    params: Record<string, unknown>,
  ): Job {
    if (!this.workerReady) {
      throw new DomainError("The render worker is unavailable; check /health/ready", 503);
    }
    const jobId = identifier();
    this.store.insertJob(
      {
        id: jobId,
        project_id: projectId,
        operation,
        input_revision_id: revisionId,
        status: "queued",
        created_at: timestamp(),
        params,
        artifact_ids: [],
      },
      this.settings.max_pending_jobs,
    );
    this.wake();
    return this.job(jobId);
  }

  job(jobId: string): Job {
    const record = this.store.job(jobId);
    const rest: Record<string, unknown> = { ...record };
    const artifactIds = (rest["artifact_ids"] as string[] | undefined) ?? [];
    delete rest["params"];
    delete rest["artifact_ids"];
    const artifacts = artifactIds.map((id) => this.artifact(id));
    const outputs: Record<string, Artifact> = {};
    for (const artifact of artifacts) {
      if (artifact.export_path && !artifact.export_path.includes("/")) {
        outputs[artifact.export_path] = artifact;
      }
    }
    rest["artifacts"] = artifacts;
    rest["outputs"] = outputs;
    rest["logs"] = condenseLog((rest["logs"] as string | undefined) ?? "");
    return JobSchema.parse(rest);
  }

  async waitForJob(jobId: string, timeoutSeconds: number | null): Promise<Job> {
    const cap = this.settings.wait_for_job_max_timeout;
    const effective = timeoutSeconds === null ? cap : Math.min(Math.max(timeoutSeconds, 0), cap);
    const deadline = Date.now() + effective * 1000;
    const pollInterval = this.settings.wait_for_job_poll_interval;
    for (;;) {
      const result = this.job(jobId);
      if (TERMINAL_JOB_STATUSES.has(result.status)) {
        return result;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return result;
      }
      await sleep(Math.min(pollInterval * 1000, remainingMs));
    }
  }

  cancelJob(jobId: string): Job {
    const job = this.store.job(jobId);
    if (job.status === "queued") {
      this.store.updateJob(jobId, { status: "cancelled", stage: "cancelled", finished_at: timestamp() });
    } else if (job.status === "running") {
      this.worker?.cancel(jobId);
      this.store.updateJob(jobId, { stage: "cancelling" });
    }
    return this.job(jobId);
  }
}
