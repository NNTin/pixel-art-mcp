/**
 * Integer pixels, top-left origin. A dot (`.`) is transparent, never an eraser.
 *
 * Verbatim port of `Canvas` in `src/pixel_art_mcp/pixel_art.py`. Every thrown `Error`'s message
 * below reproduces the source `ValueError`'s message exactly (see `docs/typescript-rewrite.md`,
 * Phase 3) -- later phases (the engine subprocess, the MCP tool layer) depend on catching and
 * surfacing these exact strings.
 */

const MIN_DIM = 1;
const MAX_DIM = 512;

export class Canvas {
  width: number;
  height: number;
  pixels: string[][];

  constructor(width: number, height: number) {
    if (width < MIN_DIM || width > MAX_DIM || height < MIN_DIM || height > MAX_DIM) {
      throw new Error("Canvas dimensions must be in 1..512");
    }
    this.width = width;
    this.height = height;
    this.pixels = Array.from({ length: height }, () => Array.from({ length: width }, () => "."));
  }

  static fromRows(rows: readonly string[]): Canvas {
    const first = rows[0];
    // `!first` is falsy for both "no row 0" (undefined) and "row 0 is an empty string" --
    // exactly mirroring Python's `not rows or not rows[0]`.
    if (rows.length === 0 || !first) {
      throw new Error("Pixel rows must form a nonempty rectangle; row 0 must not be empty");
    }
    const bad: [number, number][] = [];
    rows.forEach((row, i) => {
      if (row.length !== first.length) bad.push([i, row.length]);
    });
    if (bad.length > 0) {
      const details = bad
        .slice(0, 8)
        .map(([i, n]) => `row ${i}: expected ${first.length}, actual ${n}`)
        .join("; ");
      const remaining = bad.length > 8 ? `; ${bad.length - 8} more mismatched rows` : "";
      throw new Error(
        `Pixel rows must form a nonempty rectangle. ${details}${remaining}. ` +
          "Row indices are zero-based; use numeric drawing commands for long shapes.",
      );
    }
    // Delegates dimension bounds (1..512) to the constructor, matching Python: an overlong row 0
    // raises "Canvas dimensions must be in 1..512" here, not a rectangle-specific message.
    const canvas = new Canvas(first.length, rows.length);
    canvas.pixels = rows.map((row) => Array.from(row));
    return canvas;
  }

  get rows(): string[] {
    return this.pixels.map((row) => row.join(""));
  }

  rect(x: number, y: number, width: number, height: number, color: string): this {
    if (color.length !== 1 || Math.min(x, y, width, height) < 0) {
      throw new Error("Use a palette symbol and nonnegative integer rectangle");
    }
    if (x + width > this.width || y + height > this.height) {
      throw new Error("Rectangle exceeds canvas");
    }
    for (const row of this.pixels.slice(y, y + height)) {
      for (let i = x; i < x + width; i++) {
        row[i] = color;
      }
    }
    return this;
  }

  stamp(x: number, y: number, rows: readonly string[]): this {
    const patch = Canvas.fromRows(rows);
    if (Math.min(x, y) < 0 || x + patch.width > this.width || y + patch.height > this.height) {
      throw new Error("Stamp exceeds canvas");
    }
    patch.pixels.forEach((row, dy) => {
      row.forEach((color, dx) => {
        if (color !== ".") {
          this.rowAt(y + dy)[x + dx] = color;
        }
      });
    });
    return this;
  }

  mirrored(): Canvas {
    return Canvas.fromRows(this.rows.map((row) => Array.from(row).reverse().join("")));
  }

  line(x1: number, y1: number, x2: number, y2: number, color: string): this {
    if (color.length !== 1 || ![x1, y1, x2, y2].every((v) => Number.isInteger(v))) {
      throw new Error("Use integer line coordinates and a palette symbol");
    }
    if (
      !(
        x1 >= 0 &&
        x1 < this.width &&
        x2 >= 0 &&
        x2 < this.width &&
        y1 >= 0 &&
        y1 < this.height &&
        y2 >= 0 &&
        y2 < this.height
      )
    ) {
      throw new Error("Line exceeds canvas");
    }
    // Integer Bresenham: inclusive endpoints, no fractional coverage or antialiasing.
    let cx = x1;
    let cy = y1;
    const dx = Math.abs(x2 - x1);
    const dy = -Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      this.rowAt(cy)[cx] = color;
      if (cx === x2 && cy === y2) return this;
      const twice = 2 * error;
      if (twice >= dy) {
        error += dy;
        cx += sx;
      }
      if (twice <= dx) {
        error += dx;
        cy += sy;
      }
    }
  }

  /**
   * Guards a `pixels[y]` read before a two-level indexed write. Every call site has already
   * bounds-checked `y` against `this.height`, so the thrown error is an unreachable internal
   * invariant check, not a user-facing validation message -- this is how `noUncheckedIndexedAccess`
   * is satisfied here without a silencing `!`/`as` cast (see the package's own porting notes).
   */
  private rowAt(y: number): string[] {
    const row = this.pixels[y];
    if (row === undefined) {
      throw new RangeError(`Canvas row ${y} out of bounds (internal invariant violated)`);
    }
    return row;
  }
}

// Runtime protection (see docs/typescript-rewrite.md, "Core design decisions"): an untrusted-but-
// sandboxed render script must never be able to alter Canvas's behavior for any other job.
// Freezing the constructor and its prototype means `Canvas.prototype.rect = () => {}` throws a
// TypeError immediately, under ESM's implicit strict mode, instead of silently succeeding.
Object.freeze(Canvas);
Object.freeze(Canvas.prototype);
