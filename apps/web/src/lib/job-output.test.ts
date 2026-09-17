import { describe, expect, it } from "vitest";

import type { Job } from "../api.js";
import { pickPreviewArtifact } from "./job-output.js";

function job(outputs: Job["outputs"]): Job {
  return {
    id: "job-1",
    project_id: "project-1",
    operation: "sprites",
    status: "succeeded",
    progress: 1,
    stage: "done",
    logs: "",
    error: null,
    result_revision_id: null,
    artifacts: [],
    outputs,
  };
}

const previewArtifact = {
  id: "a1",
  filename: "preview.png",
  media_type: "image/png",
  download_url: "/artifacts/a1",
};
const sheetArtifact = {
  id: "a2",
  filename: "spritesheet.png",
  media_type: "image/png",
  download_url: "/artifacts/a2",
};

describe("pickPreviewArtifact", () => {
  it("prefers preview.png", () => {
    expect(
      pickPreviewArtifact(
        job({ "preview.png": previewArtifact, "spritesheet.png": sheetArtifact }),
      ),
    ).toBe(previewArtifact);
  });

  it("falls back to spritesheet.png when preview.png is missing", () => {
    expect(pickPreviewArtifact(job({ "spritesheet.png": sheetArtifact }))).toBe(sheetArtifact);
  });

  it("returns null when neither output exists", () => {
    expect(pickPreviewArtifact(job({ "sprites.zip": sheetArtifact }))).toBeNull();
  });
});
