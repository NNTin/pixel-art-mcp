/**
 * Shared plumbing for porting Pydantic's validation-error wording to Zod, plus the
 * `DomainError` exception class (ported from `src/pixel_art_mcp/models.py`).
 *
 * Pydantic v2's `e.errors()` reduces every failure to `{type, loc, msg}` (see
 * `contracts/fixtures/generate_fixtures.py`). Zod's own default messages/issue codes don't
 * match that wording or taxonomy, so every constraint in this package is expressed through
 * `z.object(...).superRefine(...)` (see `modelObject` below) with an explicit message string
 * copied verbatim from a real `uv run python -c "..."` probe of the Pydantic models, and an
 * explicit `pydanticType` tag carried in the issue's `params` so the contract tests can rebuild
 * the same `{type, loc, msg}` shape from a `ZodError` and diff it against the fixture.
 */

import { z } from "zod";

/** Ported from `DomainError(Exception)` in `src/pixel_art_mcp/models.py`. */
export class DomainError extends Error {
  readonly httpStatus: number;

  constructor(message: string, httpStatus = 400) {
    super(message);
    this.name = "DomainError";
    this.httpStatus = httpStatus;
  }
}

/** Mirrors the tag pydantic-core puts on each error (e.g. "value_error", "too_short"). */
export type PydanticType = string;

/** Adds a Zod issue carrying the Pydantic-style `type` tag used by the contract-fixture tests. */
export function addPydanticIssue(
  ctx: z.RefinementCtx,
  message: string,
  pydanticType: PydanticType,
  path?: (string | number)[],
): void {
  ctx.addIssue({ code: "custom", message, params: { pydanticType }, path });
}

/**
 * Wraps a raised `ValueError` message the way Pydantic v2 wraps `@model_validator`/
 * `@field_validator` failures: `type: "value_error"`, `msg: "Value error, {message}"`.
 */
export function valueError(
  ctx: z.RefinementCtx,
  message: string,
  path?: (string | number)[],
): void {
  addPydanticIssue(ctx, `Value error, ${message}`, "value_error", path);
}

export const fieldRequiredMessage = "Field required";
export const extraForbiddenMessage = "Extra inputs are not permitted";

export function geMessage(n: number): string {
  return `Input should be greater than or equal to ${n}`;
}
export function leMessage(n: number): string {
  return `Input should be less than or equal to ${n}`;
}
export function gtMessage(n: number): string {
  return `Input should be greater than ${n}`;
}
export function ltMessage(n: number): string {
  return `Input should be less than ${n}`;
}

function plural(n: number, unit: string): string {
  return n === 1 ? unit : `${unit}s`;
}

export function stringMinMessage(n: number): string {
  return `String should have at least ${n} ${plural(n, "character")}`;
}
export function stringMaxMessage(n: number): string {
  return `String should have at most ${n} ${plural(n, "character")}`;
}

export function listMinMessage(n: number, actual: number): string {
  return `List should have at least ${n} ${plural(n, "item")} after validation, not ${actual}`;
}
export function listMaxMessage(n: number, actual: number): string {
  return `List should have at most ${n} ${plural(n, "item")} after validation, not ${actual}`;
}

export function dictMinMessage(n: number, actual: number): string {
  return `Dictionary should have at least ${n} ${plural(n, "item")} after validation, not ${actual}`;
}
export function dictMaxMessage(n: number, actual: number): string {
  return `Dictionary should have at most ${n} ${plural(n, "item")} after validation, not ${actual}`;
}

export function patternMessage(pattern: string): string {
  return `String should match pattern '${pattern}'`;
}

/** Formats a Pydantic `Literal[...]` mismatch: `"Input should be 'a', 'b' or 'c'"`. */
export function literalMessage(values: readonly (string | number | boolean)[]): string {
  const format = (v: string | number | boolean): string =>
    typeof v === "string" ? `'${v}'` : String(v);
  const formatted = values.map(format);
  if (formatted.length === 0) return "Input should be nothing";
  if (formatted.length === 1) return `Input should be ${formatted[0]}`;
  const last = formatted[formatted.length - 1];
  return `Input should be ${formatted.slice(0, -1).join(", ")} or ${last}`;
}

/** Formats pydantic's `union_tag_invalid` message for a discriminated union. */
export function unionTagInvalidMessage(
  discriminator: string,
  tag: unknown,
  expectedTags: readonly string[],
): string {
  const tagRepr = typeof tag === "string" ? `'${tag}'` : JSON.stringify(tag);
  const expected = expectedTags.map((t) => `'${t}'`).join(", ");
  return `Input tag ${tagRepr} found using '${discriminator}' does not match any of the expected tags: ${expected}`;
}

interface BoundOptions {
  ge?: number;
  le?: number;
  gt?: number;
  lt?: number;
}

/** Applies `Field(ge=/le=/gt=/lt=)`-style bound checks, in the order Pydantic reports them. */
export function checkBounds(
  value: number,
  opts: BoundOptions,
  ctx: z.RefinementCtx,
  path?: (string | number)[],
): void {
  if (opts.ge !== undefined && value < opts.ge) {
    addPydanticIssue(ctx, geMessage(opts.ge), "greater_than_equal", path);
    return;
  }
  if (opts.gt !== undefined && value <= opts.gt) {
    addPydanticIssue(ctx, gtMessage(opts.gt), "greater_than", path);
    return;
  }
  if (opts.le !== undefined && value > opts.le) {
    addPydanticIssue(ctx, leMessage(opts.le), "less_than_equal", path);
    return;
  }
  if (opts.lt !== undefined && value >= opts.lt) {
    addPydanticIssue(ctx, ltMessage(opts.lt), "less_than", path);
  }
}

/**
 * Every field builder below is built on `z.unknown().superRefine(...)` rather than Zod's typed
 * primitives (`z.string()`/`z.number()`/`z.array()`/`z.record()`), so it has full control over
 * -- and can tag with a `pydanticType` -- both halves of what Pydantic reports before a
 * refinement ever runs: a missing field (`"missing"`, "Field required") and a present-but-wrong
 * JS type (`"{x}_type"`, "Input should be a valid {x}"), not just the bound/length/pattern
 * checks. Zod's own built-in versions of those two checks run *before* any `.superRefine` and
 * use Zod's own wording/issue codes, which is exactly the mismatch this whole module exists to
 * avoid (see this file's top comment).
 */
function checkRequired(value: unknown, ctx: z.RefinementCtx): boolean {
  if (value === undefined) {
    addPydanticIssue(ctx, fieldRequiredMessage, "missing");
    return false;
  }
  return true;
}

interface IntFieldOptions extends BoundOptions {
  description?: string;
}

/** A `StrictInt`/`int` field with optional `ge/le/gt/lt` bounds (`Field(...)` equivalent). */
export function intField(opts: IntFieldOptions = {}): z.ZodType<number> {
  let schema: z.ZodType<number> = z
    .unknown()
    .superRefine((value, ctx) => {
      if (!checkRequired(value, ctx)) return;
      if (typeof value !== "number" || !Number.isInteger(value)) {
        addPydanticIssue(ctx, "Input should be a valid integer", "int_type");
        return;
      }
      checkBounds(value, opts, ctx);
    })
    .transform((value) => value as number);
  if (opts.description) schema = schema.describe(opts.description);
  return schema;
}

/**
 * A `float`/`int` numeric field with optional `ge/le/gt/lt` bounds. Also rejects `Infinity`/
 * `NaN`, matching `Model.model_config = ConfigDict(allow_inf_nan=False)` -- pydantic's
 * `finite_number` issue ("Input should be a finite number"). Note this can only be exercised via
 * a direct unit test, never a JSON fixture: JSON has no literal for `Infinity`/`NaN`.
 */
export function numberField(opts: BoundOptions & { description?: string } = {}): z.ZodType<number> {
  let schema: z.ZodType<number> = z
    .unknown()
    .superRefine((value, ctx) => {
      if (!checkRequired(value, ctx)) return;
      if (typeof value !== "number") {
        addPydanticIssue(ctx, "Input should be a valid number", "float_type");
        return;
      }
      if (!Number.isFinite(value)) {
        addPydanticIssue(ctx, "Input should be a finite number", "finite_number");
        return;
      }
      checkBounds(value, opts, ctx);
    })
    .transform((value) => value as number);
  if (opts.description) schema = schema.describe(opts.description);
  return schema;
}

interface StringFieldOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  /** The literal pattern text pydantic reports, e.g. `^[A-Z][A-Z0-9_]{0,63}$`. */
  patternText?: string;
  description?: string;
}

/** A `str` field with `min_length`/`max_length`/`pattern` (`Field(...)` equivalent). */
export function stringField(opts: StringFieldOptions = {}): z.ZodType<string> {
  let schema: z.ZodType<string> = z
    .unknown()
    .superRefine((value, ctx) => {
      if (!checkRequired(value, ctx)) return;
      if (typeof value !== "string") {
        addPydanticIssue(ctx, "Input should be a valid string", "string_type");
        return;
      }
      if (opts.minLength !== undefined && value.length < opts.minLength) {
        addPydanticIssue(ctx, stringMinMessage(opts.minLength), "string_too_short");
        return;
      }
      if (opts.maxLength !== undefined && value.length > opts.maxLength) {
        addPydanticIssue(ctx, stringMaxMessage(opts.maxLength), "string_too_long");
        return;
      }
      if (opts.pattern && !opts.pattern.test(value)) {
        addPydanticIssue(
          ctx,
          patternMessage(opts.patternText ?? opts.pattern.source),
          "string_pattern_mismatch",
        );
      }
    })
    .transform((value) => value as string);
  if (opts.description) schema = schema.describe(opts.description);
  return schema;
}

/** A `list[...]` field with `min_length`/`max_length` (dynamic-count message, like Pydantic's). */
export function arrayField<Item extends z.ZodType>(
  item: Item,
  opts: { minLength?: number; maxLength?: number; description?: string } = {},
): z.ZodType<z.infer<Item>[]> {
  let schema: z.ZodType<z.infer<Item>[]> = z
    .unknown()
    .superRefine((value, ctx) => {
      if (!checkRequired(value, ctx)) return;
      if (!Array.isArray(value)) {
        addPydanticIssue(ctx, "Input should be a valid list", "list_type");
        return;
      }
      if (opts.minLength !== undefined && value.length < opts.minLength) {
        addPydanticIssue(ctx, listMinMessage(opts.minLength, value.length), "too_short");
        return;
      }
      if (opts.maxLength !== undefined && value.length > opts.maxLength) {
        addPydanticIssue(ctx, listMaxMessage(opts.maxLength, value.length), "too_long");
        return;
      }
      value.forEach((element, index) => {
        const result = item.safeParse(element);
        if (!result.success) {
          for (const issue of result.error.issues) {
            ctx.addIssue({
              ...issue,
              path: [index, ...issue.path],
            });
          }
        }
      });
    })
    // Re-parse each element (like `recordField` below) so the returned array carries each
    // item's own defaults/transforms -- not just the raw input values `superRefine` inspected.
    .transform((value) => (value as unknown[]).map((element) => item.parse(element)));
  if (opts.description) schema = schema.describe(opts.description);
  return schema;
}

/** A `dict[...]` field with `min_length`/`max_length` counted in entries, like Pydantic's. */
export function recordField<Value extends z.ZodType>(
  valueSchema: Value,
  opts: {
    minLength?: number;
    maxLength?: number;
    keyPattern?: RegExp;
    keyPatternText?: string;
    description?: string;
  } = {},
): z.ZodType<Record<string, z.infer<Value>>> {
  let schema: z.ZodType<Record<string, z.infer<Value>>> = z
    .unknown()
    .superRefine((value, ctx) => {
      if (!checkRequired(value, ctx)) return;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        addPydanticIssue(ctx, "Input should be a valid dictionary", "dict_type");
        return;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (opts.keyPattern) {
        for (const [key] of entries) {
          if (!opts.keyPattern.test(key)) {
            addPydanticIssue(
              ctx,
              patternMessage(opts.keyPatternText ?? opts.keyPattern.source),
              "string_pattern_mismatch",
              [key, "[key]"],
            );
          }
        }
      }
      if (opts.minLength !== undefined && entries.length < opts.minLength) {
        addPydanticIssue(ctx, dictMinMessage(opts.minLength, entries.length), "too_short");
        return;
      }
      if (opts.maxLength !== undefined && entries.length > opts.maxLength) {
        addPydanticIssue(ctx, dictMaxMessage(opts.maxLength, entries.length), "too_long");
        return;
      }
      for (const [key, element] of entries) {
        const result = valueSchema.safeParse(element);
        if (!result.success) {
          for (const issue of result.error.issues) {
            ctx.addIssue({
              ...issue,
              path: [key, ...issue.path],
            });
          }
        }
      }
    })
    .transform((value) => {
      const result: Record<string, unknown> = {};
      for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
        result[key] = valueSchema.parse(element);
      }
      return result as Record<string, z.infer<Value>>;
    });
  if (opts.description) schema = schema.describe(opts.description);
  return schema;
}

/**
 * A `Literal[...]` field (single or multi-valued), with pydantic's exact join wording. Built
 * on `z.unknown().superRefine(...)` rather than `z.literal(...)` so the emitted issue can carry
 * the `pydanticType: "literal_error"` tag `z.literal`'s own `invalid_value` code doesn't (see
 * `addPydanticIssue`/`modelObject`'s doc comment for why every issue in this package needs one).
 */
export function literalField<const Values extends readonly (string | number | boolean)[]>(
  values: Values,
  opts: { description?: string } = {},
): z.ZodType<Values[number]> {
  const message = literalMessage(values);
  const allowed: readonly unknown[] = values;
  let schema: z.ZodType<Values[number]> = z
    .unknown()
    .superRefine((value, ctx) => {
      if (value === undefined) {
        addPydanticIssue(ctx, fieldRequiredMessage, "missing");
        return;
      }
      if (!allowed.includes(value)) {
        addPydanticIssue(ctx, message, "literal_error");
      }
    })
    .transform((value) => value as Values[number]);
  if (opts.description) schema = schema.describe(opts.description);
  return schema;
}

// Loose enough to accept the RFC 4122 shapes pydantic's Rust UUID parser accepts, without
// reproducing its exact character-by-character parser error text (see the "UUID" note in this
// package's final report -- pydantic's `uuid_parsing` message embeds low-level parser detail,
// e.g. "invalid character: ... found `n` at 1", that isn't practical to byte-for-byte reproduce
// from a hand-written regex; this only guarantees the same accept/reject boundary and a
// reasonable, if not verbatim, message).
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A `uuid.UUID` field. See the `UUID_PATTERN` note above re: exact error-message fidelity. */
export function uuidField(opts: { description?: string } = {}): z.ZodType<string> {
  let schema = z.string().superRefine((value, ctx) => {
    if (!UUID_PATTERN.test(value)) {
      addPydanticIssue(ctx, "Input should be a valid UUID", "uuid_parsing");
    }
  });
  if (opts.description) schema = schema.describe(opts.description);
  return schema;
}

/**
 * A `discriminator`-tagged union (`Annotated[A | B | ..., Field(discriminator=...)]`), built
 * without `z.discriminatedUnion` because that requires every member to statically carry Zod's
 * internal `propValues` metadata, which this package's `modelObject`-built member schemas (each
 * wrapped in `.loose().superRefine().transform()`, needed for the per-key `extra_forbidden`
 * behavior) don't expose to the type checker even though they still parse correctly at runtime.
 * This dispatches on the tag manually and re-emits pydantic's exact `union_tag_invalid` wording.
 */
export function taggedUnion<Members extends Record<string, z.ZodType>>(
  discriminator: string,
  members: Members,
): z.ZodType<z.infer<Members[keyof Members]>> {
  const tags = Object.keys(members);
  return z.unknown().transform((raw, ctx): z.infer<Members[keyof Members]> => {
    const tag =
      raw !== null && typeof raw === "object" && discriminator in raw
        ? (raw as Record<string, unknown>)[discriminator]
        : undefined;
    const member = typeof tag === "string" ? members[tag] : undefined;
    if (!member) {
      // Pydantic reports an invalid discriminator tag at the union's own root location, not
      // under the discriminator key.
      addPydanticIssue(ctx, unionTagInvalidMessage(discriminator, tag, tags), "union_tag_invalid");
      return z.NEVER;
    }
    const result = member.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        // Pydantic's discriminated-union errors are reported under the matched tag, e.g.
        // `loc: (..., "stamp", "rows")` for a bad `Stamp` -- prepend it here to match.
        //
        // Zod v4 types `RefinementCtx.addIssue` against the specific issue shape it can infer
        // at each call site; forwarding an issue produced by an independent `safeParse` (whose
        // `$ZodIssue` union doesn't structurally match that inferred parameter type) needs an
        // explicit cast here. The object itself is untouched -- only the static type is coerced.
        ctx.addIssue({ ...issue, path: [tag, ...issue.path] } as Parameters<
          typeof ctx.addIssue
        >[0]);
      }
      return z.NEVER;
    }
    return result.data as z.infer<Members[keyof Members]>;
  });
}

/**
 * Builds a `Model`/`PixelModel`-equivalent object schema: `extra="forbid"` (reported as one
 * `extra_forbidden` issue per unknown key, matching pydantic, not Zod's single combined issue),
 * plus an optional cross-field `model_validator(mode="after")`-equivalent `refine` callback that
 * is skipped when extra keys were found, or when any individual field itself failed validation
 * -- mirroring Pydantic, which never runs an "after" validator unless every field already
 * validated successfully (running `refine` on a value with an unparsed/invalid field -- e.g. a
 * `commands` array still holding a raw, discriminator-rejected element -- can crash the callback
 * or fabricate spurious extra errors).
 */
export function modelObject<Shape extends z.ZodRawShape>(
  shape: Shape,
  refine?: (value: z.infer<z.ZodObject<Shape>>, ctx: z.RefinementCtx) => void,
): z.ZodType<z.infer<z.ZodObject<Shape>>> {
  const known = new Set(Object.keys(shape));
  return z
    .object(shape)
    .loose()
    .superRefine((value, ctx) => {
      let hasExtra = false;
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          hasExtra = true;
          addPydanticIssue(ctx, extraForbiddenMessage, "extra_forbidden", [key]);
        }
      }
      if (hasExtra || !refine) return;
      const record = value as Record<string, unknown>;
      for (const [key, fieldSchema] of Object.entries(shape)) {
        if (!(fieldSchema as z.ZodType).safeParse(record[key]).success) return;
      }
      refine(value, ctx);
    })
    .transform((value) => {
      const clean: Record<string, unknown> = {};
      for (const key of known) clean[key] = (value as Record<string, unknown>)[key];
      return clean as z.infer<z.ZodObject<Shape>>;
    });
}
