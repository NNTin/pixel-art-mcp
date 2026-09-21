/**
 * Internal-only helpers for satisfying `noUncheckedIndexedAccess` without a silencing `!`/`as`
 * cast, matching `packages/pixel-core`'s own established convention (see
 * `canvas.ts::rowAt`'s doc comment): every call site below has already bounds-checked the index
 * some other way (a loop over `0..length-1`, a `.length` comparison, a just-inserted key), so the
 * thrown error is an unreachable internal-invariant check, not a user-facing validation message.
 * Not part of this package's public surface (not re-exported from `index.ts`).
 */

/** Reads `array[index]`, throwing if it's out of bounds instead of silently returning
 * `undefined` -- used wherever the caller can already prove `index` is in range. `ArrayLike`
 * (rather than `readonly T[]`) so this also covers `Uint8Array`/`Uint16Array` element reads. */
export function at<T>(array: ArrayLike<T>, index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new RangeError(`Index ${String(index)} out of bounds (internal invariant violated)`);
  }
  return value;
}

/** Unwraps a `T | undefined` (e.g. from `Map.get`) known-defined by the caller's own logic. */
export function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new RangeError(`${what} unexpectedly missing (internal invariant violated)`);
  }
  return value;
}
