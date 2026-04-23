import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { addStaticMiddleware, getStaticRoot } from "./staticFiles.js";

// Use a temp directory for test static files
const testWebRoot = path.join(
  process.env.TMPDIR || "/tmp",
  "orchestrator-static-test",
);

describe("staticFiles", () => {
  beforeAll(() => {
    // Create test static file tree
    mkdirSync(path.join(testWebRoot, "assets"), { recursive: true });
    writeFileSync(
      path.join(testWebRoot, "index.html"),
      "<html><body>hello</body></html>",
    );
    writeFileSync(
      path.join(testWebRoot, "assets", "main.js"),
      "console.log('hi')",
    );
    writeFileSync(
      path.join(testWebRoot, "assets", "style.css"),
      "body { color: red; }",
    );
  });

  afterAll(() => {
    rmSync(testWebRoot, { recursive: true, force: true });
  });

  describe("getStaticRoot", () => {
    it("returns a path ending with web/", () => {
      const root = getStaticRoot();
      expect(root.endsWith("web")).toBe(true);
    });

    it("returns an absolute path", () => {
      const root = getStaticRoot();
      expect(path.isAbsolute(root)).toBe(true);
    });
  });

  describe("addStaticMiddleware", () => {
    function createTestApp() {
      const app = new Hono();
      // API route that should take precedence
      app.get("/api/test", (c) => c.json({ api: true }));
      app.get("/healthz", (c) => c.json({ status: "ok" }));
      addStaticMiddleware(app, testWebRoot);
      return app;
    }

    it("serves static files from the root", async () => {
      const app = createTestApp();
      const res = await app.request("/index.html");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<html>");
    });

    it("serves index.html for root path /", async () => {
      const app = createTestApp();
      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<html>");
    });

    it("serves nested static files with correct MIME type", async () => {
      const app = createTestApp();

      const jsRes = await app.request("/assets/main.js");
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get("Content-Type")).toContain("javascript");

      const cssRes = await app.request("/assets/style.css");
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get("Content-Type")).toContain("css");
    });

    it("API routes take precedence over static files", async () => {
      const app = createTestApp();
      const res = await app.request("/api/test");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ api: true });
    });

    it("non-API routes serving index.html for client-side routing fallback", async () => {
      const app = createTestApp();
      // A route like /tasks/123 doesn't exist as a file — should serve index.html
      const res = await app.request("/tasks/123");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<html>");
    });

    it("does not serve SPA fallback for /api/* routes", async () => {
      const app = createTestApp();
      // An API route that doesn't exist should 404, not serve index.html
      const res = await app.request("/api/nonexistent");
      expect(res.status).toBe(404);
    });

    it("healthz still works", async () => {
      const app = createTestApp();
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok" });
    });
  });
});
