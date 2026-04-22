/**
 * GET /api/blobs/:hash
 *
 * Returns the raw blob content for the given sha256 hash.
 * Content-Type is text/plain by default (binary blobs are served as-is).
 * Returns 404 with a problem-details JSON body if the hash is not found.
 */

import { Hono } from "hono";
import { getBlob } from "../blobStore.js";

export function createBlobRoutes(): Hono {
  const app = new Hono();

  app.get("/api/blobs/:hash", (c) => {
    const { hash } = c.req.param();

    // Basic sanity check: sha256 hex is exactly 64 lowercase hex chars
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return c.json(
        {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          detail: "hash must be a 64-character lowercase hex string",
        },
        400,
      );
    }

    const content = getBlob(hash);

    if (content === null) {
      return c.json(
        {
          type: "about:blank",
          title: "Not Found",
          status: 404,
          detail: `No blob found for hash: ${hash}`,
        },
        404,
      );
    }

    // Default to text/plain; callers can rely on the raw bytes
    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.body(content.toString());
  });

  return app;
}
