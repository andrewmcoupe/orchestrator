/**
 * Static file serving for production (npx) mode.
 *
 * Serves the pre-built frontend from dist/web/ via Hono serveStatic middleware.
 * In dev mode the directory won't contain built files, so requests fall through
 * to a 404 (Vite handles the frontend separately on its own port).
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

/**
 * Returns the absolute path to the built frontend directory.
 *
 * When compiled: dist/server/staticFiles.js → ../web → dist/web/
 * When dev (tsx): server/staticFiles.ts → ../web → web/ (no built files, harmless)
 */
export function getStaticRoot(): string {
  return path.resolve(import.meta.dirname, "..", "web");
}

/**
 * Adds static file serving and SPA fallback to a Hono app.
 *
 * Must be called AFTER all API routes are mounted so they take precedence.
 *
 * @param app - The Hono app instance
 * @param root - Override for the static root directory (used in tests)
 */
export function addStaticMiddleware(app: Hono, root?: string): void {
  const staticRoot = root ?? getStaticRoot();

  // Serve static files (JS, CSS, images, etc.)
  app.use("/*", serveStatic({ root: staticRoot }));

  // SPA fallback: serve index.html for non-API routes that didn't match a file.
  // This enables client-side routing (e.g. /tasks/123 → index.html).
  app.get("*", (c) => {
    // Don't serve fallback for API routes — let them 404 normally.
    if (c.req.path.startsWith("/api/")) {
      return c.notFound();
    }

    const indexPath = path.join(staticRoot, "index.html");
    if (!existsSync(indexPath)) {
      return c.notFound();
    }

    const html = readFileSync(indexPath, "utf-8");
    return c.html(html);
  });
}
