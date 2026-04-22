/**
 * Content-addressable blob store.
 *
 * Blobs are stored at <basePath>/<first-2-hex-of-hash>/<full-sha256-hash>.
 * Writes are atomic: content is written to a .tmp file then renamed into place.
 * Identical content is automatically deduplicated (same hash → same file path).
 *
 * Default basePath: orchestrator/.data/blobs/
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getBlobsDir } from "./paths.js";

export type BlobStore = {
  /** Store content and return its sha256 hex hash. Idempotent. */
  putBlob(content: string | Buffer): { hash: string };
  /** Retrieve stored content as a Buffer, or null if not found. */
  getBlob(hash: string): Buffer | null;
  /** Check whether a blob with the given hash exists. */
  hasBlob(hash: string): boolean;
};

/**
 * Creates a blob store rooted at the given basePath.
 * Provide a custom basePath in tests to use a temporary directory.
 */
export function createBlobStore(basePath: string): BlobStore {
  function blobPath(hash: string): string {
    return path.join(basePath, hash.slice(0, 2), hash);
  }

  function putBlob(content: string | Buffer): { hash: string } {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const dest = blobPath(hash);

    // Fast path: already stored
    if (fs.existsSync(dest)) {
      return { hash };
    }

    // Ensure shard directory exists
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    // Atomic write: write to .tmp then rename
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);

    return { hash };
  }

  function getBlob(hash: string): Buffer | null {
    const p = blobPath(hash);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  function hasBlob(hash: string): boolean {
    return fs.existsSync(blobPath(hash));
  }

  return { putBlob, getBlob, hasBlob };
}

// ============================================================================
// Default singleton instance
// ============================================================================

const defaultStore = createBlobStore(getBlobsDir());

export const putBlob = defaultStore.putBlob.bind(defaultStore);
export const getBlob = defaultStore.getBlob.bind(defaultStore);
export const hasBlob = defaultStore.hasBlob.bind(defaultStore);
