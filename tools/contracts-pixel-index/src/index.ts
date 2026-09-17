/**
 * Standalone live pixel-index schema-compatibility checker (port of `contracts/pixel_index/`).
 * See `docs/typescript-rewrite.md`'s "Contract preservation strategy" section. This barrel is a
 * convenience for tests and any future in-process reuse; the CLI entrypoints (`verify.ts`,
 * `generate-status-site.ts`) are invoked directly via `node dist/<file>.js` and are not part of
 * the main app's dependency graph.
 */

export {
  CHECKS,
  checkAssetsList,
  checkManifestSchemaCharacter,
  checkManifestSchemaFurniture,
  checkManifestSchemaPet,
  checkOpenapiQueryShape,
  checkRoot,
  type CheckContext,
  type CheckFn,
  type CheckResult,
  type CheckStatus,
} from "./checks.js";

export {
  buildResultDocument,
  formatReport,
  run,
  writeResultDocument,
  type ResultDocument,
} from "./verify.js";

export {
  badgeDocument,
  buildSnapshot,
  generateSite,
  loadResults,
  type BuildSnapshotOptions,
  type GenerateSiteOptions,
} from "./generate-status-site.js";
