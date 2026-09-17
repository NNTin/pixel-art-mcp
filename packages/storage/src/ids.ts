/**
 * Ported from `identifier()`/`timestamp()` in `src/pixel_art_mcp/storage/store.py`.
 *
 * Python's `datetime.now(UTC).isoformat()` renders the UTC offset as `+00:00`
 * (e.g. `2026-09-16T12:00:00.000000+00:00`), while JS's `Date.prototype.toISOString()`
 * renders it as `Z` (e.g. `2026-09-16T12:00:00.000Z`) and only carries millisecond
 * precision rather than Python's microseconds. Neither difference is observable by any
 * caller in this codebase: timestamps are stored as opaque strings and only ever compared
 * with `ORDER BY`/`<`/`>` (which works identically for both formats, since both are
 * lexicographically sortable ISO-8601 strings), never re-parsed into a component-by-component
 * structure. We standardize on `toISOString()`'s `Z` form as the one canonical TS format
 * rather than hand-rolling a `+00:00` suffix to imitate Python byte-for-byte.
 */

export function identifier(): string {
  return crypto.randomUUID();
}

export function timestamp(): string {
  return new Date().toISOString();
}
