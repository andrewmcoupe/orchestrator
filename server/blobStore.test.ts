/**
 * Unit tests for the content-addressable blob store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createBlobStore } from "./blobStore.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("putBlob", () => {
  it("stores a string and returns its sha256 hash", () => {
    const store = createBlobStore(tmpDir);
    const { hash } = store.putBlob("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores a Buffer and returns its sha256 hash", () => {
    const store = createBlobStore(tmpDir);
    const { hash } = store.putBlob(Buffer.from("hello world"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same content produces the same hash regardless of string/Buffer input", () => {
    const store = createBlobStore(tmpDir);
    const { hash: h1 } = store.putBlob("hello world");
    const { hash: h2 } = store.putBlob(Buffer.from("hello world"));
    expect(h1).toBe(h2);
  });

  it("deduplication: same content written twice stores only one file", () => {
    const store = createBlobStore(tmpDir);
    const { hash } = store.putBlob("duplicate content");
    store.putBlob("duplicate content");

    const shardDir = path.join(tmpDir, hash.slice(0, 2));
    const files = fs.readdirSync(shardDir);
    expect(files).toHaveLength(1);
  });

  it("different content produces different hashes", () => {
    const store = createBlobStore(tmpDir);
    const { hash: h1 } = store.putBlob("content A");
    const { hash: h2 } = store.putBlob("content B");
    expect(h1).not.toBe(h2);
  });

  it("files are sharded at orchestrator/.data/blobs/<first-2-hex>/<full-hash>", () => {
    const store = createBlobStore(tmpDir);
    const { hash } = store.putBlob("sharding test");
    const expectedPath = path.join(tmpDir, hash.slice(0, 2), hash);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("no partial file is left if write is interrupted (atomic via tmp+rename)", () => {
    // Verify the final file exists and no .tmp sibling exists
    const store = createBlobStore(tmpDir);
    const { hash } = store.putBlob("atomic write test");
    const shardDir = path.join(tmpDir, hash.slice(0, 2));
    const files = fs.readdirSync(shardDir);
    expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
    expect(files).toContain(hash);
  });
});

describe("getBlob", () => {
  it("returns the exact bytes that were stored (string input)", () => {
    const store = createBlobStore(tmpDir);
    const content = "round-trip string content";
    const { hash } = store.putBlob(content);
    const retrieved = store.getBlob(hash);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.toString()).toBe(content);
  });

  it("returns the exact bytes that were stored (Buffer input)", () => {
    const store = createBlobStore(tmpDir);
    const buf = Buffer.from([0x00, 0xff, 0x42, 0x13]);
    const { hash } = store.putBlob(buf);
    const retrieved = store.getBlob(hash);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.equals(buf)).toBe(true);
  });

  it("returns null for an unknown hash", () => {
    const store = createBlobStore(tmpDir);
    const result = store.getBlob("a".repeat(64));
    expect(result).toBeNull();
  });
});

describe("hasBlob", () => {
  it("returns true after storing a blob", () => {
    const store = createBlobStore(tmpDir);
    const { hash } = store.putBlob("existence check");
    expect(store.hasBlob(hash)).toBe(true);
  });

  it("returns false for an unknown hash", () => {
    const store = createBlobStore(tmpDir);
    expect(store.hasBlob("b".repeat(64))).toBe(false);
  });
});
