/**
 * Public surface of `@pixel-art-mcp/service`: Phase 6a's reference-image ingestion (upload +
 * SSRF-safe URL download) and chunked artifact delivery, plus Phase 6b's project/revision/job
 * orchestration (`Service`) and the real `JobExecutor` that fills `packages/jobs`' pluggable
 * worker seam (`createJobExecutor`). See `references.ts`/`artifacts.ts`/`service.ts`/
 * `job-executor.ts`'s doc comments for what each ports and why.
 */

export {
  downloadReference,
  normalizeReference,
  publicTarget,
  type DnsLookup,
  type NormalizeReferenceResult,
  type PinnedTarget,
  type ReferenceLimits,
} from "./references.js";

export {
  MAX_ARTIFACT_CHUNK_BYTES,
  MAX_INLINE_ARTIFACT_BYTES,
  readArtifactChunk,
  type ArtifactChunk,
} from "./artifacts.js";

export { isGlobalAddress } from "./net/ip-range.js";

export { condenseLog } from "./log-condense.js";

export { guessMediaType, readImageDimensions } from "./media-type.js";

export { DEFAULT_SERVICE_SETTINGS, type ServiceSettings } from "./settings.js";

export {
  buildSaveScript,
  definitionToArt,
  validateAuthoredArt,
} from "./pixel-authoring.js";

export { Service, type WorkerHandle } from "./service.js";

export { createJobExecutor } from "./job-executor.js";
