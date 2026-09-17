import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, getScript, renderAsset, saveScript } from "./api.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiError", () => {
  it("carries the HTTP status alongside the message", () => {
    const error = new ApiError(409, "Scene revision changed");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Scene revision changed");
    expect(error.name).toBe("ApiError");
  });
});

describe("getScript", () => {
  it("GETs /api/projects/:id/script and returns the parsed body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { project_id: "p1", revision_id: null, script: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getScript("p1");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/script");
    expect(result).toEqual({ project_id: "p1", revision_id: null, script: "" });
  });

  it("throws ApiError with the server's error message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(404, { error: "Unknown project" })),
    );
    await expect(getScript("missing")).rejects.toMatchObject({
      status: 404,
      message: "Unknown project",
    });
  });
});

describe("saveScript", () => {
  it("POSTs the script and expected_revision_id as JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { id: "job-1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    await saveScript("p1", "export default () => {};", "rev-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/script",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ script: "export default () => {};", expected_revision_id: "rev-1" }),
      }),
    );
  });

  it("surfaces a 409 as ApiError so the caller can show the conflict banner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(409, { error: "Scene revision changed" })),
    );
    await expect(saveScript("p1", "x", null)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("renderAsset", () => {
  it("reuses the existing REST render route with the revision id as a query param", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { id: "job-2", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    await renderAsset("p1", "rev-2");

    expect(fetchMock).toHaveBeenCalledWith("/projects/p1/asset/renders?revision_id=rev-2", {
      method: "POST",
    });
  });
});
