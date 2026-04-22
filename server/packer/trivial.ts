/**
 * Trivial Context Packer — tier-1 implementation.
 *
 * Packs context for each phase without any symbol-graph traversal.
 * - test-author: proposition texts + heuristic file mentions + existing test files
 * - implementer: proposition texts + failing gate output + test-author files + retry feedback
 * - auditor:     proposition texts + git diff + retry feedback
 *
 * Stores the manifest JSON in the blob store and returns the hash.
 */

import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type {
  ContextManifest,
  ContextPolicy,
  AuditConcern,
} from "@shared/events.js";
import type { TaskDetailRow, AttemptRow } from "@shared/projections.js";
import type { BlobStore } from "../blobStore.js";

// ============================================================================
// Public types
// ============================================================================

export type PackInput = {
  db: Database.Database;
  phase_name: string;
  task: TaskDetailRow;
  /** Current attempt (null only if called before the first attempt.started). */
  attempt: AttemptRow | null;
  worktree_path: string;
  policy: ContextPolicy;
  blobStore: BlobStore;
};

export type PackResult = {
  prompt: string;
  /** Optional path to a system prompt file (not produced by trivial packer). */
  system_prompt_file?: string;
  manifest: ContextManifest;
  manifest_hash: string;
};

/** Injectable dependencies — swap out for tests without touching the FS. */
export type TrivialPackerDeps = {
  gitDiff?: (worktreePath: string) => Promise<string>;
  findTestFiles?: (worktreePath: string) => Promise<string[]>;
};

// ============================================================================
// Token estimation
// ============================================================================

/** ~3.5 chars/token is a conservative approximation for mixed code/prose. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ============================================================================
// File helpers
// ============================================================================

/** Extract file path mentions from free text (e.g. "update src/auth/login.ts"). */
function extractFileMentions(text: string): string[] {
  const matches =
    text.match(
      /(?:^|[\s("`'])([^\s("`']*\/[^\s("`']*\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|vue|svelte))/gm,
    ) ?? [];
  return [
    ...new Set(
      matches
        .map((m) =>
          m.trim().replace(/^["`'(]/, "").replace(/["`').,;]$/, ""),
        )
        .filter((p) => p.includes("/") && !p.startsWith("//") && !p.startsWith("http")),
    ),
  ];
}

/** Recursively find test files under a directory, returning paths relative to root. */
function walkForTestFiles(dir: string, root: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkForTestFiles(full, root));
    } else if (
      entry.isFile() &&
      /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name)
    ) {
      results.push(path.relative(root, full));
    }
  }
  return results;
}

async function defaultGitDiff(worktreePath: string): Promise<string> {
  try {
    const result = await execa("git", ["diff", "HEAD"], { cwd: worktreePath });
    return result.stdout;
  } catch {
    return "";
  }
}

async function defaultFindTestFiles(worktreePath: string): Promise<string[]> {
  return walkForTestFiles(worktreePath, worktreePath);
}

// ============================================================================
// Event log queries
// ============================================================================

function getPropositionTexts(
  db: Database.Database,
  ids: string[],
): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT payload_json FROM events
       WHERE type = 'proposition.extracted'
       AND json_extract(payload_json, '$.proposition_id') IN (${placeholders})`,
    )
    .all(...ids) as Array<{ payload_json: string }>;
  return rows.map(
    (r) => (JSON.parse(r.payload_json) as { text: string }).text,
  );
}

function getRetryFeedback(
  db: Database.Database,
  attempt_id: string,
): AuditConcern[] {
  const row = db
    .prepare(
      `SELECT payload_json FROM events
       WHERE type = 'attempt.started'
       AND json_extract(payload_json, '$.attempt_id') = ?
       LIMIT 1`,
    )
    .get(attempt_id) as { payload_json: string } | undefined;
  if (!row) return [];
  const payload = JSON.parse(row.payload_json) as {
    retry_feedback?: AuditConcern[];
  };
  return payload.retry_feedback ?? [];
}

function getGateFailures(db: Database.Database, attempt_id: string): string {
  const rows = db
    .prepare(
      `SELECT payload_json FROM events
       WHERE type = 'gate.failed'
       AND correlation_id = ?
       ORDER BY ts DESC
       LIMIT 5`,
    )
    .all(attempt_id) as Array<{ payload_json: string }>;
  if (rows.length === 0) return "";
  return rows
    .map((r) => {
      const p = JSON.parse(r.payload_json) as {
        gate_name: string;
        failures: Array<{
          location?: { path: string; line: number; col?: number };
          excerpt: string;
        }>;
      };
      const lines = (p.failures ?? [])
        .slice(0, 10)
        .map((f) =>
          f.location
            ? `${f.location.path}:${f.location.line}: ${f.excerpt}`
            : f.excerpt,
        )
        .join("\n");
      return `[${p.gate_name}]\n${lines}`;
    })
    .join("\n\n");
}

function getTestAuthorFiles(
  db: Database.Database,
  attempt_id: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(e.payload_json, '$.path') as file_path
       FROM events e
       WHERE e.type = 'invocation.file_edited'
       AND json_extract(e.payload_json, '$.invocation_id') IN (
         SELECT json_extract(i.payload_json, '$.invocation_id')
         FROM events i
         WHERE i.type = 'invocation.started'
         AND i.correlation_id = ?
         AND json_extract(i.payload_json, '$.phase_name') = 'test-author'
       )`,
    )
    .all(attempt_id) as Array<{ file_path: string | null }>;
  return rows
    .map((r) => r.file_path)
    .filter((p): p is string => p !== null);
}

// ============================================================================
// Prompt builders
// ============================================================================

function propositionsBlock(texts: string[], taskTitle: string): string {
  if (texts.length === 0) return `## Task\n\n${taskTitle}`;
  return (
    "## Requirements\n\n" + texts.map((t, i) => `${i + 1}. ${t}`).join("\n")
  );
}

function formatRetryFeedback(concerns: AuditConcern[]): string {
  if (concerns.length === 0) return "";
  return (
    "\n\n## Prior Auditor Concerns\n\n" +
    concerns
      .map(
        (c) =>
          `- [${c.severity.toUpperCase()}] ${c.category}: ${c.rationale}`,
      )
      .join("\n")
  );
}

// ============================================================================
// Main pack function
// ============================================================================

export async function pack(
  input: PackInput,
  deps?: TrivialPackerDeps,
): Promise<PackResult> {
  const { db, phase_name, task, attempt, worktree_path, policy, blobStore } =
    input;

  const gitDiff = deps?.gitDiff ?? defaultGitDiff;
  const findTestFiles = deps?.findTestFiles ?? defaultFindTestFiles;

  const propTexts = getPropositionTexts(db, task.proposition_ids);
  const reqs = propositionsBlock(propTexts, task.title);

  let prompt: string;
  const files: ContextManifest["files"] = [];

  switch (phase_name) {
    case "test-author": {
      const mentionedFiles = propTexts.flatMap(extractFileMentions);
      const testFiles = await findTestFiles(worktree_path);
      const allFiles = [...new Set([...mentionedFiles, ...testFiles])];

      for (const f of allFiles) {
        let bytes = 0;
        try {
          bytes = fs.statSync(path.resolve(worktree_path, f)).size;
        } catch {
          /* file may not exist yet — bytes stays 0 */
        }
        files.push({ path: f, bytes });
      }

      const fileList =
        allFiles.length > 0
          ? "\n\n## Relevant Files\n\n" +
            allFiles.map((f) => `- ${f}`).join("\n")
          : "";

      prompt =
        `${reqs}${fileList}\n\n` +
        "Write tests for the requirements above. " +
        "Focus on behaviour, not implementation details. " +
        "Use the existing test patterns in the codebase.";
      break;
    }

    case "implementer": {
      const gateFailures = attempt
        ? getGateFailures(db, attempt.attempt_id)
        : "";
      const retryFeedback = attempt
        ? getRetryFeedback(db, attempt.attempt_id)
        : [];
      const testAuthorFiles = attempt
        ? getTestAuthorFiles(db, attempt.attempt_id)
        : [];

      for (const f of testAuthorFiles) {
        files.push({ path: f, bytes: 0 });
      }

      const gateBlock = gateFailures
        ? `\n\n## Failing Gates\n\n\`\`\`\n${gateFailures}\n\`\`\``
        : "";
      const feedbackBlock = formatRetryFeedback(retryFeedback);
      const fileList =
        testAuthorFiles.length > 0
          ? "\n\n## Test Files to Make Pass\n\n" +
            testAuthorFiles.map((f) => `- ${f}`).join("\n")
          : "";

      prompt =
        `${reqs}${gateBlock}${feedbackBlock}${fileList}\n\n` +
        "Implement the requirements. Make the failing tests pass. " +
        "Keep changes focused and minimal. " +
        "Claude Code will explore the repo for additional context.";
      break;
    }

    case "auditor": {
      const diff = await gitDiff(worktree_path);
      const retryFeedback = attempt
        ? getRetryFeedback(db, attempt.attempt_id)
        : [];

      // Extract changed file paths from diff headers
      for (const m of diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) {
        files.push({ path: m[1], bytes: 0 });
      }

      const diffBlock = diff
        ? `\n\n## Changes Made\n\n\`\`\`diff\n${diff}\n\`\`\``
        : "\n\n(No changes detected in worktree)";
      const feedbackBlock = formatRetryFeedback(retryFeedback);

      prompt =
        `${reqs}${diffBlock}${feedbackBlock}\n\n` +
        "Review the changes against the requirements. " +
        "Return your verdict as JSON conforming to the schema in the system prompt.";
      break;
    }

    default: {
      prompt = `${reqs}\n\nComplete the task as described.`;
      break;
    }
  }

  const tokenEstimated = estimateTokens(prompt);
  const manifest: ContextManifest = {
    symbols: [],
    files,
    token_budget: policy.token_budget,
    token_estimated: tokenEstimated,
  };
  const { hash: manifest_hash } = blobStore.putBlob(JSON.stringify(manifest));

  return { prompt, manifest, manifest_hash };
}
