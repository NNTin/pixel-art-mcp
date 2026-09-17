/**
 * The gold-standard automated proof this phase's brief asks for: load the real built page, edit
 * the real CodeMirror editor, click "Save & Run", and wait for a real rendered image to appear --
 * against a real running `apps/server` (see `../playwright.config.ts`), not a mocked backend.
 */

import { expect, test, type APIRequestContext } from "@playwright/test";

// The default furniture asset profile expects a full 16x16 canvas declared on all four angles --
// `PixelArt.validateTarget` rejects a render whose declared views don't match exactly (see
// `apps/server/src/web-api/routes.test.ts`'s own `FURNITURE_SCRIPT`, which this mirrors).
const FURNITURE_SCRIPT = [
  'import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";',
  "",
  "export default function main(scene: Scene): void {",
  '  const art = new PixelArt({ D: "#293039", G: "#f3cf65" }, { 0: [16, 16], 90: [16, 16], 180: [16, 16], 270: [16, 16] });',
  '  const row = "DGDGDGDGDGDGDGDG";',
  "  const canvas = Canvas.fromRows(Array.from({ length: 16 }, () => row));",
  "  for (const angle of [0, 90, 180, 270]) {",
  '    art.layer("body", angle, canvas);',
  "  }",
  "  art.save(scene);",
  "}",
].join("\n");

async function createConfiguredProject(request: APIRequestContext): Promise<string> {
  const created = await request.post("/projects", { data: { name: "E2E Chair" } });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string };

  const configured = await request.put(`/projects/${project.id}/asset`, {
    data: { kind: "furniture", name: "E2E Chair", asset_id: "E2E_CHAIR" },
  });
  expect(configured.ok()).toBe(true);

  return project.id;
}

test("edit a script, Save & Run, and see the rendered image appear", async ({ page, request }) => {
  const projectId = await createConfiguredProject(request);

  await page.goto(`/?project=${projectId}`);

  const editorContent = page.locator(".cm-content");
  await expect(editorContent).toBeVisible();

  // Wait for the initial (empty) script load to finish before typing -- otherwise the load
  // effect could race the edit and clobber it.
  await expect(page.getByRole("button", { name: /save & run/i })).toBeEnabled();

  await editorContent.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  // `insertText` (a single bulk text-insertion event) rather than `type` (per-keystroke) so
  // CodeMirror's bracket/quote auto-closing doesn't fight character-by-character typing.
  await page.keyboard.insertText(FURNITURE_SCRIPT);
  await expect(editorContent).toContainText("PixelArt");

  await page.getByRole("button", { name: /save & run/i }).click();

  // The script job runs first (compile + real engine subprocess), then the chained render job
  // (real imaging export) -- both real work, hence the generous timeout.
  await expect(page.locator(".status-succeeded").first()).toBeVisible({ timeout: 45_000 });

  const image = page.locator("img.rendered-image");
  await expect(image).toBeVisible({ timeout: 45_000 });
  await expect(image).toHaveJSProperty("complete", true);
  const naturalWidth = await image.evaluate((el: HTMLImageElement) => el.naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);
});
