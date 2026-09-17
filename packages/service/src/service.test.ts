/**
 * Unit coverage of `Service`'s public API, matching `Service`'s Python counterpart
 * (`src/pixel_art_mcp/projects/service.py`) method by method where practical. The real
 * end-to-end script/render job flow is covered separately in `job-executor.e2e.test.ts`, which
 * exercises a real `Worker`/engine subprocess/imaging pipeline -- these tests use a lightweight
 * fake `WorkerHandle` instead, so they can assert `_submit`'s gating and `cancelJob`'s dispatch
 * logic in isolation, quickly, without spawning real subprocesses.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AssetSpecSchema, DomainError, PixelDefinitionSchema } from "@pixel-art-mcp/schema";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Service, type WorkerHandle } from "./service.js";

interface FakeWorker extends Omit<WorkerHandle, "isReady"> {
  isReady: boolean;
  cancelledIds: string[];
  woken: number;
}

let dir: string;
let service: Service;
let fakeWorker: FakeWorker;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-service-test-"));
  service = new Service({ data_dir: dir });
  fakeWorker = {
    isReady: true,
    cancelledIds: [],
    woken: 0,
    wake() {
      this.woken += 1;
    },
    cancel(jobId: string) {
      this.cancelledIds.push(jobId);
      return true;
    },
  };
  service.attachWorker(fakeWorker);
});

afterEach(() => {
  service.store.close();
  rmSync(dir, { recursive: true, force: true });
});

function furnitureSpec(overrides: Record<string, unknown> = {}) {
  return AssetSpecSchema.parse({ kind: "furniture", name: "Chair", asset_id: "CHAIR", ...overrides });
}

describe("capabilities", () => {
  it("reports a coherent shape", () => {
    const caps = service.capabilities();
    expect(caps["schema_version"]).toBe(1);
    expect(caps["worker_ready"]).toBe(true);
    expect(caps["transport"]).toBe("streamable-http");
    const limits = caps["limits"] as Record<string, unknown>;
    expect(limits["max_script_bytes"]).toBeGreaterThan(0);
    expect(limits["max_inline_artifact_bytes"]).toBeGreaterThan(0);
    const assetProfiles = caps["asset_profiles"] as Record<string, unknown>;
    expect(Object.keys(assetProfiles)).toEqual(["furniture", "character", "pet"]);
  });

  it("reflects worker_ready off when no worker is attached", () => {
    const bare = new Service({ data_dir: mkdtempSync(path.join(tmpdir(), "pixel-art-service-bare-")) });
    expect(bare.capabilities()["worker_ready"]).toBe(false);
    bare.store.close();
  });
});

describe("createProject / listProjects / getProject", () => {
  it("creates and lists projects", () => {
    const project = service.createProject("  My Project  ");
    expect(project.name).toBe("My Project");
    expect(project.current_revision_id).toBeNull();
    expect(service.listProjects().map((p) => p.id)).toContain(project.id);
  });

  it("rejects an empty or overlong name", () => {
    expect(() => service.createProject("   ")).toThrow(DomainError);
    expect(() => service.createProject("x".repeat(121))).toThrow(DomainError);
    try {
      service.createProject("");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).message).toBe("Project name must contain 1–120 characters");
    }
  });

  it("getProject includes references/revisions/asset_configuration", () => {
    const project = service.createProject("Chair");
    const detail = service.getProject(project.id);
    expect(detail.project.id).toBe(project.id);
    expect(detail.references).toEqual([]);
    expect(detail.revisions).toEqual([]);
    expect(detail.asset_configuration).toBeNull();
  });

  it("getProject 404s for an unknown project", () => {
    expect(() => service.getProject("00000000-0000-4000-8000-000000000000")).toThrow(DomainError);
  });
});

describe("configureAsset / assetConfiguration", () => {
  it("stores a configuration and returns the latest one", () => {
    const project = service.createProject("Chair");
    expect(service.assetConfiguration(project.id)).toBeNull();
    const first = service.configureAsset(project.id, furnitureSpec());
    expect(service.assetConfiguration(project.id)?.id).toBe(first.id);
    const second = service.configureAsset(project.id, furnitureSpec({ name: "Chair v2" }));
    expect(service.assetConfiguration(project.id)?.id).toBe(second.id);
  });
});

describe("revision", () => {
  it("throws 409 when the project has no revision yet", () => {
    const project = service.createProject("Chair");
    try {
      service.revision(project.id);
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).httpStatus).toBe(409);
    }
  });
});

describe("renderAsset / writePixelArt gating", () => {
  it("requires configure_asset before render_asset", () => {
    const project = service.createProject("Chair");
    expect(() => service.renderAsset(project.id)).toThrow(/configure_asset before render_asset/);
  });

  it("requires configure_asset before write_pixel_art", () => {
    const project = service.createProject("Chair");
    const definition = PixelDefinitionSchema.parse({
      palette: { D: "#293039", G: "#f3cf65" },
      layers: [{ name: "body", poses: [{ angle: 0, rows: ["D"] }] }],
    });
    expect(() => service.writePixelArt(project.id, definition, null)).toThrow(
      /configure_asset before write_pixel_art/,
    );
  });

  it("rejects a pixel-art definition that doesn't match the configured canvases", () => {
    const project = service.createProject("Chair");
    service.configureAsset(project.id, furnitureSpec());
    // "small" furniture is 16x16 per angle; a 1x1 patch fails validateTarget's dimension check
    // once converted through the real pixel-core engine.
    const definition = PixelDefinitionSchema.parse({
      palette: { D: "#293039", G: "#f3cf65" },
      layers: [{ name: "body", poses: [{ angle: 0, rows: ["D"] }] }],
    });
    expect(() => service.writePixelArt(project.id, definition, null)).toThrow(DomainError);
  });
});

describe("_submit gating via submitScript/submitRender", () => {
  it("rejects job submission when the worker is not ready", () => {
    fakeWorker.isReady = false;
    const project = service.createProject("Chair");
    try {
      service.submitScript(project.id, "export default function main(){}", null);
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).httpStatus).toBe(503);
    }
  });

  it("wakes the attached worker after a successful submission", () => {
    const project = service.createProject("Chair");
    service.submitScript(project.id, "export default function main(){}", null);
    expect(fakeWorker.woken).toBeGreaterThan(0);
  });

  it("rejects a stale expected_revision_id", () => {
    const project = service.createProject("Chair");
    expect(() =>
      service.submitScript(project.id, "export default function main(){}", "00000000-0000-4000-8000-000000000000"),
    ).toThrow(DomainError);
  });

  it("rejects an empty script", () => {
    const project = service.createProject("Chair");
    expect(() => service.submitScript(project.id, "   ", null)).toThrow(
      /Script is empty or exceeds the script size limit/,
    );
  });

  it("rejects render submission without an asset spec", () => {
    const project = service.createProject("Chair");
    // A render with no `asset` in `options` -- `submitRender`'s very first guard.
    const bogus = { asset: null } as unknown as Parameters<typeof service.submitRender>[1];
    expect(() => service.submitRender(project.id, bogus)).toThrow(
      /Generic rendering is unavailable/,
    );
  });
});

describe("job / cancelJob", () => {
  it("cancels a queued job outright", () => {
    const project = service.createProject("Chair");
    const job = service.submitScript(project.id, "export default function main(){}", null);
    expect(job.status).toBe("queued");
    const cancelled = service.cancelJob(job.id);
    expect(cancelled.status).toBe("cancelled");
    expect(fakeWorker.cancelledIds).toEqual([]);
  });

  it("delegates a running job's cancellation to the attached worker", () => {
    const project = service.createProject("Chair");
    const job = service.submitScript(project.id, "export default function main(){}", null);
    service.store.updateJob(job.id, { status: "running" });
    const cancelled = service.cancelJob(job.id);
    expect(cancelled.stage).toBe("cancelling");
    expect(fakeWorker.cancelledIds).toEqual([job.id]);
  });

  it("condenses long logs through Service.job()", () => {
    const project = service.createProject("Chair");
    const job = service.submitScript(project.id, "export default function main(){}", null);
    const longLog = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`).join("\n");
    service.store.updateJob(job.id, { logs: longLog });
    const refreshed = service.job(job.id);
    expect(refreshed.logs.length).toBeLessThan(longLog.length);
    expect(refreshed.logs).toContain("line(s) omitted");
  });
});

describe("waitForJob", () => {
  it("returns immediately once the job reaches a terminal status", async () => {
    const project = service.createProject("Chair");
    const job = service.submitScript(project.id, "export default function main(){}", null);
    service.store.updateJob(job.id, { status: "succeeded", finished_at: new Date().toISOString() });
    const result = await service.waitForJob(job.id, 5);
    expect(result.status).toBe("succeeded");
  });

  it("times out and returns the still-queued job", async () => {
    const project = service.createProject("Chair");
    const job = service.submitScript(project.id, "export default function main(){}", null);
    const result = await service.waitForJob(job.id, 0.05);
    expect(result.status).toBe("queued");
  });
});

describe("reference ingestion", () => {
  async function pngBuffer(): Promise<Buffer> {
    return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer();
  }

  it("addReference stores original/image/thumbnail artifacts and a reference record", async () => {
    const project = service.createProject("Chair");
    const png = await pngBuffer();
    const reference = await service.addReference(project.id, new Uint8Array(png), "photo.png");
    expect(reference.width).toBe(8);
    expect(reference.height).toBe(8);
    expect(service.reference(reference.id).id).toBe(reference.id);
    expect(service.artifact(reference.original_artifact_id).kind).toBe("reference");
    expect(service.artifact(reference.image_artifact_id).kind).toBe("reference_image");
    expect(service.artifact(reference.thumbnail_artifact_id).kind).toBe("thumbnail");
  });

  it("addReferenceInput requires exactly one of data_base64/file", async () => {
    const project = service.createProject("Chair");
    await expect(service.addReferenceInput(project.id, null, null, "x.png")).rejects.toThrow(DomainError);
    const file = { download_url: "https://example.invalid/x.png", file_id: "f1", mime_type: "", file_name: "" };
    await expect(
      service.addReferenceInput(project.id, "aGVsbG8=", file, "x.png"),
    ).rejects.toThrow(DomainError);
  });

  it("addReferenceInput decodes a valid base64 upload", async () => {
    const project = service.createProject("Chair");
    const png = await pngBuffer();
    const reference = await service.addReferenceInput(project.id, png.toString("base64"), null, "photo.png");
    expect(reference.width).toBe(8);
  });

  it("addReferenceInput rejects invalid base64", async () => {
    const project = service.createProject("Chair");
    await expect(service.addReferenceInput(project.id, "not-base64!!!", null, "x.png")).rejects.toThrow(
      DomainError,
    );
  });
});

describe("artifact / artifactPath", () => {
  it("404s for a missing artifact record", () => {
    expect(() => service.artifact("00000000-0000-4000-8000-000000000000")).toThrow(DomainError);
  });
});
