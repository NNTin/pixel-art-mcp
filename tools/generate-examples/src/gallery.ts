/**
 * HTML-generation helpers for `index.ts`'s gallery `index.html`, factored out into pure
 * functions so they're unit-testable without a running server. Port of the string-building tail
 * of `scripts/generate_examples.py`'s `generate()` and its module-level `clip_links_html`.
 */

/** Port of Python's `html.escape(s, quote=True)`: escapes `&`, `<`, `>`, `"`, `'`. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/** Every other file `generate()` writes into an example's folder -- any `*.zip` beyond these is
 * one `splitMultiClipZip` wrote (its filename is the clip's own asset id), and gets its own
 * gallery download link. */
export const KNOWN_ZIP_FILENAMES: ReadonlySet<string> = new Set([
  "sprites.zip",
  "pixel-agents.zip",
  "pixel-agents-character.zip",
  "pixel-agents-pet.zip",
]);

/** `exampleDirName` is the example's folder name (e.g. `"rain-barrel"`); `zipFilenamesInDir` is
 * every `*.zip` filename actually present in that folder (caller does the `fs.readdir`, keeping
 * this function pure). */
export function clipLinksHtml(
  exampleDirName: string,
  zipFilenamesInDir: readonly string[],
): string {
  const clipZips = [...zipFilenamesInDir].filter((name) => !KNOWN_ZIP_FILENAMES.has(name)).sort();
  if (clipZips.length === 0) return "";
  const links = clipZips
    .map((name) => {
      const stem = name.endsWith(".zip") ? name.slice(0, -".zip".length) : name;
      return `<a href="${escapeHtml(exampleDirName)}/${escapeHtml(name)}">${escapeHtml(stem)}</a>`;
    })
    .join(" · ");
  return (
    "<p>Not directly uploadable to pixel-index as one zip (multiple states, " +
    `see docs/contract-testing.md) -- individual states: ${links}</p>`
  );
}

/** One gallery card for an example that produced a `preview.html` (i.e. actually finished). */
export function exampleCardHtml(name: string, clipLinks: string): string {
  const n = escapeHtml(name);
  return (
    `<article><h2><a href="${n}/preview.html">${n}</a></h2>` +
    `<a href="${n}/preview.html">` +
    `<img src="${n}/context.png" alt="${n} in approximate placement context"></a>` +
    `<p><a href="${n}/sprites.zip">Download all outputs</a> · ` +
    `<a href="${n}/asset-report.json">Diagnostics</a></p>` +
    clipLinks +
    "</article>"
  );
}

/** The gallery's top-level `index.html`, verbatim port of `generate_examples.py`'s inline
 * template string. */
export function galleryIndexHtml(cardsHtml: string, hasWebview: boolean): string {
  const webview = hasWebview
    ? '<p><a href="webview/index.html">Actual webview renderer: before / after gallery</a></p>'
    : "";
  return (
    '<!doctype html><meta charset="utf-8"><title>Game assets</title>' +
    "<style>body{font:16px system-ui;background:#182027;color:#e6eef4;margin:24px}" +
    "a{color:#a4cefb}main{display:flex;flex-wrap:wrap;gap:24px}" +
    "img{width:320px;image-rendering:pixelated}h2{font-size:20px}</style>" +
    "<h1>Pixel Agents asset previews</h1><p>Generated through MCP. " +
    "Open an example for animation, placement controls, and source comparison.</p>" +
    webview +
    "<main>" +
    cardsHtml +
    "</main>"
  );
}
