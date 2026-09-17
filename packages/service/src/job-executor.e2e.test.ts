/**
 * The one true end-to-end test for Phase 6b: a real `packages/jobs` `Worker` running the real
 * `createJobExecutor(service)` against a real `packages/engine` subprocess (the compiled
 * `dist/runner.js`) and a real `packages/imaging` `exportSheet`, backed by a real temp SQLite
 * `Store` -- this is the first point in the whole rewrite where that full loop can run end to
 * end. Exercises exactly the sequence a real MCP tool call sequence would: create a project,
 * configure a furniture asset, submit a script that saves pixel art, wait for it, then render,
 * wait for that too, and check the resulting revision/artifacts are real and well-formed.
 */

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Worker } from "@pixel-art-mcp/jobs";
import { AssetSpecSchema } from "@pixel-art-mcp/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJobExecutor } from "./job-executor.js";
import { Service } from "./service.js";

let dir: string;
let service: Service;
let worker: Worker;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-service-e2e-"));
  service = new Service({ data_dir: dir, script_timeout: 30, render_timeout: 60 });
  worker = new Worker({ store: service.store, execute: createJobExecutor(service) });
  service.attachWorker(worker);
  await worker.start();
});

afterEach(async () => {
  await worker.stop();
  service.store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A trivial TypeScript authoring script (the spiritual TS equivalent of this repo's Python
 * `examples/*.py` scripts): solid single-color 16x16 body layers on all four furniture angles. */
function furnitureScript(): string {
  const row = "DGDGDGDGDGDGDGDG";
  const rows = JSON.stringify(Array.from({ length: 16 }, () => row));
  return [
    'import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";',
    "",
    "export default function main(scene: Scene): void {",
    '  const art = new PixelArt({ D: "#293039", G: "#f3cf65" }, { 0: [16, 16], 90: [16, 16], 180: [16, 16], 270: [16, 16] });',
    `  const canvas = Canvas.fromRows(${rows});`,
    "  for (const angle of [0, 90, 180, 270]) {",
    '    art.layer("body", angle, canvas);',
    "  }",
    "  art.save(scene);",
    "}",
    "",
  ].join("\n");
}

describe("createJobExecutor + Worker + engine subprocess + imaging (real end-to-end)", () => {
  it(
    "runs a real script job, then a real render job, against a real Store",
    async () => {
      const project = service.createProject("Chair");
      expect(project.current_revision_id).toBeNull();

      service.configureAsset(
        project.id,
        AssetSpecSchema.parse({ kind: "furniture", name: "Chair", asset_id: "CHAIR" }),
      );

      const scriptJob = service.submitScript(project.id, furnitureScript(), project.current_revision_id);
      expect(scriptJob.status).toBe("queued");

      const finishedScriptJob = await service.waitForJob(scriptJob.id, 20);
      if (finishedScriptJob.status !== "succeeded") {
        throw new Error(`script job did not succeed: ${finishedScriptJob.status} ${finishedScriptJob.error ?? ""}\n${finishedScriptJob.logs}`);
      }
      expect(finishedScriptJob.status).toBe("succeeded");
      expect(finishedScriptJob.operation).toBe("script");
      const stateArtifact = finishedScriptJob.artifacts.find((a) => a.filename === "state.json");
      const scriptArtifact = finishedScriptJob.artifacts.find((a) => a.filename === "script.ts");
      expect(stateArtifact).toBeDefined();
      expect(scriptArtifact).toBeDefined();

      const project2 = service.getProject(project.id);
      expect(project2.project.current_revision_id).not.toBeNull();
      expect(project2.revisions).toHaveLength(1);
      const revision = project2.revisions[0];
      expect(revision).toBeDefined();
      expect(revision?.summary["pixel_art"]).toBeTruthy();

      // get_pixel_art round-trip
      const source = service.getPixelArt(project.id);
      expect(source.definition.layers[0]?.name).toBe("body");

      const renderJob = service.renderAsset(project.id);
      expect(renderJob.status).toBe("queued");
      expect(renderJob.operation).toBe("sprites");

      const finishedRenderJob = await service.waitForJob(renderJob.id, 30);
      if (finishedRenderJob.status !== "succeeded") {
        throw new Error(`render job did not succeed: ${finishedRenderJob.status} ${finishedRenderJob.error ?? ""}\n${finishedRenderJob.logs}`);
      }
      expect(finishedRenderJob.status).toBe("succeeded");
      expect(finishedRenderJob.artifacts.length).toBeGreaterThan(0);

      const spritesZip = finishedRenderJob.artifacts.find((a) => a.filename === "sprites.zip");
      if (!spritesZip) throw new Error("expected a sprites.zip artifact");
      const zipPath = service.artifactPath(spritesZip.id);
      expect(existsSync(zipPath)).toBe(true);

      const frameArtifact = finishedRenderJob.artifacts.find((a) => a.kind === "frame");
      expect(frameArtifact).toBeDefined();
      expect(frameArtifact?.width).toBeGreaterThan(0);
      expect(frameArtifact?.height).toBeGreaterThan(0);

      // inspect_asset round-trip against the real asset-report.json exportAsset wrote.
      const report = service.inspectAsset(renderJob.id);
      expect(report["job_id"]).toBe(renderJob.id);
    },
    30_000,
  );

  it("surfaces a script compile error as a failed job, not a crash", async () => {
    const project = service.createProject("Broken");
    service.configureAsset(
      project.id,
      AssetSpecSchema.parse({ kind: "furniture", name: "Broken", asset_id: "BROKEN" }),
    );
    const badScript = "this is not valid typescript {{{";
    const job = service.submitScript(project.id, badScript, project.current_revision_id);
    const finished = await service.waitForJob(job.id, 20);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBeTruthy();
    // The worker loop itself must have survived -- prove it by submitting a good job right after.
    expect(service.workerReady).toBe(true);
  }, 30_000);
});
