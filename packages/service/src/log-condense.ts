/**
 * Verbatim port of `src/pixel_art_mcp/jobs/log_condense.py` (63 lines): condenses a job's raw
 * stdout/stderr log for tool/human consumption. `Job.logs` is already capped to the last
 * `max_log_bytes` while a job streams (`packages/jobs`' `runProcess`), but that cap exists to
 * bound *stored* size, not to make the field reasonable for an LLM tool result -- see the Python
 * source's doc comment for the full rationale (a real incident where an animator agent's repeated
 * `get_job` polls on one animated render blew an LLM's context window purely from this field).
 * Wired in at the single `Service.job()` choke point every `get_job`/`submit_script`/
 * `submit_render`/`cancel_job` call returns through.
 */

const TAIL_LINES = 40;
const MAX_ERROR_LINES = 20;
const MAX_LINE_CHARS = 500;
const ERROR_PATTERN = /error|traceback|exception/i;

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}... [${String(line.length - MAX_LINE_CHARS)} more chars]`;
}

/**
 * Mirrors Python's `str.splitlines()`: splits on `\n`, `\r\n`, and bare `\r`, with no trailing
 * empty element for a final newline (unlike a plain `split("\n")`).
 */
function splitLines(log: string): string[] {
  if (log === "") return [];
  return log.split(/\r\n|\r|\n/);
}

export function condenseLog(log: string): string {
  if (!log) return log;
  const lines = splitLines(log);
  if (lines.length <= TAIL_LINES) return log;

  const tailStart = lines.length - TAIL_LINES;
  const tail = lines.slice(tailStart);
  const errorLines = lines.slice(0, tailStart).filter((line) => ERROR_PATTERN.test(line));

  const sections: string[] = [];
  if (errorLines.length > 0) {
    const shown = errorLines.slice(-MAX_ERROR_LINES);
    const omittedErrors = errorLines.length - shown.length;
    if (omittedErrors > 0) {
      sections.push(`... (${String(omittedErrors)} earlier error line(s) omitted) ...`);
    }
    sections.push(...shown.map(clipLine));
    sections.push("");
  }
  sections.push(`... (${String(tailStart)} line(s) omitted) ...`);
  sections.push(...tail.map(clipLine));
  return sections.join("\n");
}
