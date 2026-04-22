/**
 * Tests for GET /api/blobs/:hash
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { testClient } from "hono/testing";
import { createBlobRoutes } from "./blobs.js";

// We mock the blobStore module so these tests don't touch disk
vi.mock("../blobStore.js", () => ({
  putBlob: vi.fn(),
  getBlob: vi.fn(),
  hasBlob: vi.fn(),
}));

import { getBlob } from "../blobStore.js";

const VALID_HASH = "a".repeat(64);

function buildApp() {
  const app = new Hono();
  app.route("/", createBlobRoutes());
  return app;
}

describe("GET /api/blobs/:hash", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 200 with the blob content when found", async () => {
    vi.mocked(getBlob).mockReturnValue(Buffer.from("hello blob"));
    const app = buildApp();
    const res = await app.request(`/api/blobs/${VALID_HASH}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello blob");
  });

  it("returns 404 with problem-details when hash is not found", async () => {
    vi.mocked(getBlob).mockReturnValue(null);
    const app = buildApp();
    const res = await app.request(`/api/blobs/${VALID_HASH}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe(404);
    expect(body.detail).toContain(VALID_HASH);
  });

  it("returns 400 for a malformed hash", async () => {
    const app = buildApp();
    const res = await app.request("/api/blobs/not-a-valid-hash");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe(400);
  });

  it("returns text/plain content-type for found blobs", async () => {
    vi.mocked(getBlob).mockReturnValue(Buffer.from("data"));
    const app = buildApp();
    const res = await app.request(`/api/blobs/${VALID_HASH}`);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
