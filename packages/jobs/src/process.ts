/**
 * Port of `src/pixel_art_mcp/jobs/process.py` (85 lines): spawn a command, stream its combined
 * stdout+stderr into a rolling, size-capped log, parse `PIXEL_PROGRESS {json}`-prefixed lines,
 * and race the process's exit against a cancellation signal and a timeout -- always killing the
 * whole process tree on the way out, success or failure.
 *
 * Two deliberate replacements from the Python source, both called out in
 * `docs/typescript-rewrite.md`'s stack-choices table:
 *
 * - `os.killpg(pid, signal)` (kills a POSIX process *group*, which only works because Python
 *   spawns with `start_new_session=True`, making the child its own group leader) becomes the
 *   `tree-kill` npm package. `tree-kill` walks the actual OS process tree (via `ps`/`pgrep` on
 *   POSIX, WMIC on Windows) rather than relying on process-group membership, so it also catches
 *   descendants that re-parent themselves out of the original group -- a strictly more thorough
 *   guarantee than `os.killpg` gave, not just a same-behavior swap. `spawn(..., { detached: true
 * })` is kept anyway (matching `start_new_session=True`) so the child doesn't share this
 *   process's controlling terminal/signal disposition.
 * - `asyncio.Event` (Python's cancellation signal) becomes a standard `AbortSignal` -- the
 *   idiomatic Node equivalent with the same "external code calls `.abort()`, this code listens
 *   for the `abort` event" shape, and the type this package's `JobExecutor` seam (see
 *   `worker.ts`) is built around.
 *
 * Node's `child_process` delivers stdout/stderr as two independent streams rather than Python's
 * single OS-level `stdout=PIPE, stderr=STDOUT` merge, so exact byte-for-byte interleaving between
 * the two streams isn't reproducible here -- both streams are drained through the same handler
 * (`onChunk`), appended to the same rolling log buffer, so content from both is captured and
 * capped identically; only the precise interleave order when both are writing concurrently can
 * differ from the Python original. In practice this port's target processes (a compiled `node`
 * script per `docs/typescript-rewrite.md`'s "Script sandboxing" section) are expected to write
 * `PIXEL_PROGRESS` lines to stdout only, so this doesn't affect progress parsing.
 */

import { spawn, type ChildProcess } from "node:child_process";

import treeKill from "tree-kill";

/** Ported from `ProcessFailure(Exception)` in `src/pixel_art_mcp/jobs/process.py`. */
export class ProcessFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessFailure";
  }
}

/**
 * Thrown when `cancel` fires before the process finished on its own. Python's `run_process`
 * signals this the same way its caller signals every other kind of interruption -- by letting
 * `asyncio.CancelledError` propagate -- since `asyncio.CancelledError` is a first-class control
 * flow primitive in Python with no real TS equivalent, this is a plain, distinctly-named error
 * class instead, so a `JobExecutor` (see `worker.ts`) can `instanceof`-check for it specifically.
 */
export class ProcessCancelled extends Error {
  constructor() {
    super("Execution was cancelled");
    this.name = "ProcessCancelled";
  }
}

export type ProgressPayload = Record<string, unknown>;

export interface RunProcessOptions {
  /** `[executable, ...args]`, matching Python's `list[str]` passed to `create_subprocess_exec`. */
  command: readonly string[];
  cwd: string;
  /** Seconds, matching Python's `float` timeout. */
  timeout: number;
  cancel: AbortSignal;
  /** Rolling log cap, in bytes (tail-only, like Python's `(log + chunk)[-log_limit:]`). */
  logLimit: number;
  onUpdate: (log: string, progress: ProgressPayload | null) => void;
}

const PROGRESS_PREFIX = "PIXEL_PROGRESS ";
const NEWLINE = 0x0a;
const LINE_BUFFER_CAP = 4096;
const STOP_GRACE_PERIOD_MS = 2000;

/**
 * Spawns `command`, streams its output into a capped rolling log via `onUpdate`, and resolves
 * once the process exits successfully -- or rejects with `ProcessFailure` (non-zero exit or
 * timeout) or `ProcessCancelled` (the `cancel` signal fired first). The process tree is always
 * killed before this settles, matching Python's `finally: await stop_process(process)`.
 */
export async function runProcess(options: RunProcessOptions): Promise<void> {
  const { command, cwd, timeout, cancel, logLimit, onUpdate } = options;
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new ProcessFailure("No command was given to execute");
  }

  const child = spawn(executable, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = Buffer.alloc(0);
  let lineBuffer = Buffer.alloc(0);

  function onChunk(chunk: Buffer): void {
    log = Buffer.concat([log, chunk]);
    if (log.length > logLimit) log = log.subarray(log.length - logLimit);

    lineBuffer = Buffer.concat([lineBuffer, chunk]);
    let progress: ProgressPayload | null = null;
    let newlineIndex: number;
    // Mirrors Python's `while b"\n" in line_buffer`.
    while ((newlineIndex = lineBuffer.indexOf(NEWLINE)) !== -1) {
      const line = lineBuffer.subarray(0, newlineIndex);
      lineBuffer = lineBuffer.subarray(newlineIndex + 1);
      if (line.toString("utf8").startsWith(PROGRESS_PREFIX)) {
        try {
          const parsed: unknown = JSON.parse(line.subarray(PROGRESS_PREFIX.length).toString("utf8"));
          // Only the last progress line in this drained batch wins, and malformed JSON is
          // silently swallowed -- both match `jobs/process.py`'s `drain()` exactly.
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            progress = parsed as ProgressPayload;
          }
        } catch {
          // Swallowed: matches `contextlib.suppress(ValueError, UnicodeError)` in the Python
          // source -- a malformed PIXEL_PROGRESS line is just not a progress update.
        }
      }
    }
    if (lineBuffer.length > LINE_BUFFER_CAP) {
      lineBuffer = lineBuffer.subarray(lineBuffer.length - LINE_BUFFER_CAP);
    }
    // Node's Buffer#toString("utf8") substitutes U+FFFD for invalid sequences, the same
    // fallback behavior as Python's `.decode("utf-8", errors="replace")`.
    onUpdate(log.toString("utf8"), progress);
  }

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      void finish();
    }, timeout * 1000);

    const onAbort = (): void => {
      cancelled = true;
      void finish();
    };
    cancel.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error: Error) => {
      void finish(error);
    });

    child.once("close", (code) => {
      if (!settled && !timedOut && !cancelled) {
        void finish(undefined, code);
      }
    });

    async function finish(spawnError?: Error, exitCode?: number | null): Promise<void> {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancel.removeEventListener("abort", onAbort);
      await stopProcess(child);
      if (spawnError) {
        reject(spawnError);
      } else if (cancelled) {
        reject(new ProcessCancelled());
      } else if (timedOut) {
        reject(new ProcessFailure(`Execution exceeded ${formatSeconds(timeout)} seconds`));
      } else if (exitCode !== 0) {
        reject(new ProcessFailure(`Renderer exited with code ${String(exitCode)}; inspect job logs`));
      } else {
        resolve();
      }
    }
  });
}

/**
 * Ported from `stop_process` in `src/pixel_art_mcp/jobs/process.py`: SIGTERM, wait up to a 2s
 * grace period, then SIGKILL, then wait unconditionally for the tree to actually be gone. Safe
 * to call on an already-exited process -- `tree-kill` failures (e.g. "no such process") are
 * swallowed, matching Python's `contextlib.suppress(ProcessLookupError)`.
 */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const exited = onceClosed(child);
  await killTree(child.pid, "SIGTERM");
  if (await withTimeout(exited, STOP_GRACE_PERIOD_MS)) {
    await killTree(child.pid, "SIGKILL");
  }
  await exited;
}

function killTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, signal, () => {
      resolve();
    });
  });
}

function onceClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => {
      resolve();
    });
  });
}

/** Resolves `true` if `ms` elapsed before `promise` settled, `false` if `promise` won the race. */
function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(true);
    }, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Approximates Python's `f"{timeout:g}"` (default 6-significant-digit `%g` formatting: fixed
 * notation with trailing zeros stripped, falling back to exponential notation for very large or
 * very small magnitudes). This is a reasonable approximation, not a byte-for-byte port -- Python's
 * `%g` and JS's `toPrecision`/`toExponential` round and switch to exponential notation on subtly
 * different boundaries for exotic inputs. Every realistic input here is a small positive
 * integer-or-one-decimal-place number of seconds from a config value (e.g. `30`, `300.5`), for
 * which this produces an identical string to Python's `%g`.
 */
function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const precision = 6;
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= precision) {
    return value.toExponential(precision - 1).replace(/\.?0+e/, "e");
  }
  const decimals = Math.max(0, precision - 1 - exponent);
  const fixed = value.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
