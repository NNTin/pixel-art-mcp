import { describe, expect, it } from "vitest";

import { clipLinksHtml, escapeHtml, exampleCardHtml, galleryIndexHtml } from "./gallery.js";

describe("escapeHtml", () => {
  it("escapes the five characters Python's html.escape(quote=True) escapes", () => {
    expect(escapeHtml(`a & b < c > "d" 'e'`)).toBe(
      "a &amp; b &lt; c &gt; &quot;d&quot; &#x27;e&#x27;",
    );
  });
});

describe("clipLinksHtml", () => {
  it("returns an empty string when only known zip filenames are present", () => {
    expect(clipLinksHtml("thermometer", ["sprites.zip", "pixel-agents.zip"])).toBe("");
  });

  it("links every unrecognized zip, sorted, with its stem as link text", () => {
    const html = clipLinksHtml("rain-barrel", [
      "sprites.zip",
      "pixel-agents.zip",
      "RAIN_BARREL_FULL.zip",
      "RAIN_BARREL_EMPTY.zip",
    ]);
    expect(html).toContain('<a href="rain-barrel/RAIN_BARREL_EMPTY.zip">RAIN_BARREL_EMPTY</a>');
    expect(html).toContain('<a href="rain-barrel/RAIN_BARREL_FULL.zip">RAIN_BARREL_FULL</a>');
    // Sorted: EMPTY before FULL.
    expect(html.indexOf("RAIN_BARREL_EMPTY")).toBeLessThan(html.indexOf("RAIN_BARREL_FULL"));
    expect(html).toContain("Not directly uploadable to pixel-index as one zip");
  });

  it("escapes an example directory name containing markup", () => {
    const html = clipLinksHtml('a"b', ["extra.zip"]);
    expect(html).toContain('href="a&quot;b/extra.zip"');
  });
});

describe("exampleCardHtml", () => {
  it("renders a card linking to the example's preview, sprites.zip, and diagnostics", () => {
    const html = exampleCardHtml("chair", "");
    expect(html).toContain('<a href="chair/preview.html">chair</a>');
    expect(html).toContain('<img src="chair/context.png"');
    expect(html).toContain('<a href="chair/sprites.zip">Download all outputs</a>');
    expect(html).toContain('<a href="chair/asset-report.json">Diagnostics</a>');
    expect(html.endsWith("</article>")).toBe(true);
  });

  it("appends the given clip-links fragment before closing the article", () => {
    const html = exampleCardHtml("rain-barrel", "<p>extra</p>");
    expect(html).toContain("<p>extra</p></article>");
  });
});

describe("galleryIndexHtml", () => {
  it("omits the webview link when there is no webview build", () => {
    const html = galleryIndexHtml("<article>x</article>", false);
    expect(html).not.toContain("webview/index.html");
    expect(html).toContain("<main><article>x</article></main>");
  });

  it("includes the webview link when a webview build is present", () => {
    const html = galleryIndexHtml("", true);
    expect(html).toContain('<a href="webview/index.html">');
  });
});
