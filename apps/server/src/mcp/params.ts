/**
 * Minimal, local Zod schemas for MCP/REST parameters that don't correspond to an existing
 * `@pixel-art-mcp/schema` model (plain UUID path/query params, `get_asset_profile`'s bounded
 * tile-count scalars, `get_artifact_chunk`'s offset/length bounds, etc.) -- per the phase
 * instructions: reuse `packages/schema`'s Zod schemas for whole models (`AssetSpec`,
 * `PixelDefinition`, `PixelEdits`, ...), define small local schemas for everything else.
 *
 * `packages/schema` does have its own `uuidField`/`UUID_PATTERN`/`intField` with Pydantic-verbatim
 * error wording (see `packages/schema/src/errors.ts`), but those are internal to that package
 * (not re-exported from its `index.ts` -- only whole models are part of its public surface), so
 * this file's `UUID_PATTERN` is an intentional, small duplication of that regex rather than an
 * import.
 */

import { z } from "zod";

export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function uuidParam(description?: string): z.ZodType<string> {
  const schema = z.string().regex(UUID_PATTERN, "Input should be a valid UUID");
  return description ? schema.describe(description) : schema;
}

export function nullableUuidParam(description?: string): z.ZodType<string | null> {
  return uuidParam(description).nullable();
}

export function boundedInt(opts: {
  ge?: number;
  le?: number;
  description?: string;
}): z.ZodType<number> {
  let schema = z.number().int();
  if (opts.ge !== undefined) schema = schema.gte(opts.ge);
  if (opts.le !== undefined) schema = schema.lte(opts.le);
  return opts.description ? schema.describe(opts.description) : schema;
}
