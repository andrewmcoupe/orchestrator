/**
 * Unified prompt seeding from bundled prompts/*.md files.
 *
 * On first run, if no prompt_version.created events exist in the DB,
 * discovers all prompts matching the {phase}-v{N}.md convention, stores
 * their content in the blob store, and emits prompt_version.created events.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { BlobStore } from "./blobStore.js";
import { putBlob } from "./blobStore.js";
import { appendAndProject } from "./projectionRunner.js";

// ============================================================================
// Filename convention: {phaseClass}-v{N}.md
// ============================================================================

const PROMPT_FILENAME_RE = /^(.+)-v(\d+)\.md$/;

export interface PromptFileMeta {
  id: string;
  name: string;
  phaseClass: string;
  filePath: string;
}

/**
 * Parse a prompt filename into its metadata.
 * Returns null if the filename doesn't match the convention.
 */
export function parsePromptFilename(
  filename: string,
): { id: string; name: string; phaseClass: string } | null {
  const m = PROMPT_FILENAME_RE.exec(filename);
  if (!m) return null;

  const phaseClass = m[1];
  const name = filename.replace(/\.md$/, "");
  const id = `pv-${name}`;

  return { id, name, phaseClass };
}

/**
 * Discover all prompt .md files in a directory that match the naming convention.
 */
export function discoverPromptFiles(promptsDir: string): PromptFileMeta[] {
  if (!fs.existsSync(promptsDir)) return [];

  return fs
    .readdirSync(promptsDir)
    .filter((f) => PROMPT_FILENAME_RE.test(f))
    .map((f) => {
      const meta = parsePromptFilename(f)!;
      return { ...meta, filePath: path.join(promptsDir, f) };
    });
}

// ============================================================================
// Seeding
// ============================================================================

const SEED_ACTOR = { kind: "system" as const, component: "gate_runner" as const };

/**
 * Returns the default prompts directory bundled with the package.
 */
export function getPackagePromptsDir(): string {
  // Works in both dev (server/seedPrompts.ts → ..) and
  // prod (dist/server/seedPrompts.js → ../..)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(__dirname, "..", "prompts");
  if (fs.existsSync(candidate)) return candidate;
  return path.join(__dirname, "..", "..", "prompts");
}

/**
 * Seed the prompt library if it is empty. Idempotent — if any
 * prompt_version.created events already exist, this is a no-op.
 *
 * @param db - The SQLite database
 * @param promptsDir - Directory containing prompt .md files (defaults to bundled prompts/)
 * @param blobStore - Blob store for template content (defaults to the default singleton)
 */
export function seedPrompts(
  db: Database.Database,
  promptsDir?: string,
  blobStore?: BlobStore,
): void {
  const dir = promptsDir ?? getPackagePromptsDir();
  const files = discoverPromptFiles(dir);
  const store = blobStore ?? { putBlob, getBlob: () => null, hasBlob: () => false };

  for (const file of files) {
    // Skip if this specific prompt version was already seeded
    const existing = db
      .prepare(
        "SELECT id FROM events WHERE type = 'prompt_version.created' AND aggregate_id = ? LIMIT 1",
      )
      .get(file.id);
    if (existing) continue;

    const template = fs.readFileSync(file.filePath, "utf-8");
    const template_hash = createHash("sha256").update(template).digest("hex");

    // Store template content in blob store
    store.putBlob(template);

    appendAndProject(db, {
      type: "prompt_version.created",
      aggregate_type: "prompt_version",
      aggregate_id: file.id,
      actor: SEED_ACTOR,
      payload: {
        prompt_version_id: file.id,
        name: file.name,
        phase_class: file.phaseClass,
        template,
        template_hash,
        notes: `Seeded from ${path.basename(file.filePath)}`,
      },
    });
  }
}
