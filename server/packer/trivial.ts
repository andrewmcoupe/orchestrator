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
  gitDiffFromBase?: (worktreePath: string, baseSha?: string) => Promise<string>;
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

/**
 * Returns the full accumulated diff from base_sha to the working tree.
 * This includes both committed changes from previous attempts AND any
 * unstaged changes from the current attempt.
 */
async function defaultGitDiffFromBase(worktreePath: string, baseSha?: string): Promise<string> {
  if (!baseSha) return "";
  try {
    const result = await execa("git", ["diff", baseSha], { cwd: worktreePath });
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

type PropositionDetail = {
  text: string;
  prd_id: string;
  source_span: { section: string; line_start: number; line_end: number } | null;
};

function getPropositionDetails(
  db: Database.Database,
  ids: string[],
): PropositionDetail[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT payload_json FROM events
       WHERE type = 'proposition.extracted'
       AND json_extract(payload_json, '$.proposition_id') IN (${placeholders})`,
    )
    .all(...ids) as Array<{ payload_json: string }>;
  return rows.map((r) => {
    const p = JSON.parse(r.payload_json) as {
      text: string;
      prd_id: string;
      source_span?: { section: string; line_start: number; line_end: number };
    };
    return { text: p.text, prd_id: p.prd_id, source_span: p.source_span ?? null };
  });
}

function getPropositionTexts(
  db: Database.Database,
  ids: string[],
): string[] {
  return getPropositionDetails(db, ids).map((p) => p.text);
}

function getPrdContent(db: Database.Database, prdId: string): string | null {
  const row = db
    .prepare(
      `SELECT json_extract(payload_json, '$.content') as content FROM events
       WHERE type = 'prd.ingested'
       AND json_extract(payload_json, '$.prd_id') = ?
       LIMIT 1`,
    )
    .get(prdId) as { content: string | null } | undefined;
  return row?.content ?? null;
}

/**
 * Extract relevant PRD sections from source spans.
 * Returns the union of all referenced line ranges with ~1 paragraph of
 * surrounding context on each side. Non-contiguous gaps are joined with ellipses.
 */
function extractPrdSections(
  prdContent: string,
  spans: Array<{ section: string; line_start: number; line_end: number }>,
): string {
  const lines = prdContent.split("\n");
  const CONTEXT_LINES = 5; // ~1 paragraph of surrounding context

  // Build a set of line ranges (1-indexed) with context
  const ranges: Array<[number, number]> = spans.map((s) => [
    Math.max(1, s.line_start - CONTEXT_LINES),
    Math.min(lines.length, s.line_end + CONTEXT_LINES),
  ]);

  // Sort and merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  // Extract and join with ellipses between gaps
  const sections: string[] = [];
  for (const [start, end] of merged) {
    sections.push(lines.slice(start - 1, end).join("\n"));
  }
  return sections.join("\n\n...\n\n");
}

/**
 * Extract the "Implementation Touchpoints" or similar file-change table from the PRD.
 */
function extractChangesInScope(prdContent: string): string | null {
  // Look for a markdown table under a heading containing "touchpoint", "files", or "changes"
  const lines = prdContent.split("\n");
  let inTable = false;
  let tableStart = -1;
  const tableLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+.*(touchpoint|implementation|files.*change|changes.*scope)/i.test(line)) {
      inTable = true;
      tableStart = i;
      tableLines.push(line);
      continue;
    }
    if (inTable) {
      if (/^##\s/.test(line) && i !== tableStart) {
        break; // hit next section
      }
      tableLines.push(line);
    }
  }

  if (tableLines.length <= 1) return null;
  return tableLines.join("\n").trim();
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

function isRetryAttempt(
  db: Database.Database,
  attempt_id: string,
): boolean {
  const row = db
    .prepare(
      `SELECT payload_json FROM events
       WHERE type = 'attempt.started'
       AND json_extract(payload_json, '$.attempt_id') = ?
       LIMIT 1`,
    )
    .get(attempt_id) as { payload_json: string } | undefined;
  if (!row) return false;
  const payload = JSON.parse(row.payload_json) as {
    previous_attempt_id?: string;
  };
  return !!payload.previous_attempt_id;
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

function acceptanceCriteriaBlock(texts: string[]): string {
  if (texts.length === 0) return "";
  return (
    "## Acceptance criteria\n\n" + texts.map((t, i) => `${i + 1}. ${t}`).join("\n")
  );
}

/**
 * Build the Background section from PRD content and proposition source spans.
 * If any proposition lacks a source_span, falls back to the full PRD text.
 */
function backgroundBlock(
  db: Database.Database,
  propositions: PropositionDetail[],
): string {
  if (propositions.length === 0) return "";

  // Get unique PRD IDs
  const prdIds = [...new Set(propositions.map((p) => p.prd_id))];
  const prdContents = new Map<string, string>();
  for (const id of prdIds) {
    const content = getPrdContent(db, id);
    if (content) prdContents.set(id, content);
  }

  if (prdContents.size === 0) return "";

  // Check if any proposition is missing source_span — fallback to full PRD
  const missingSpans = propositions.some((p) => !p.source_span);

  const sections: string[] = [];
  for (const [prdId, content] of prdContents) {
    if (missingSpans) {
      // Fallback: include full PRD text
      sections.push(content);
    } else {
      const spans = propositions
        .filter((p) => p.prd_id === prdId && p.source_span)
        .map((p) => p.source_span!);
      if (spans.length > 0) {
        sections.push(extractPrdSections(content, spans));
      }
    }
  }

  if (sections.length === 0) return "";
  return "## Background\n\n" + sections.join("\n\n---\n\n");
}

function changesInScopeBlock(
  db: Database.Database,
  propositions: PropositionDetail[],
): string {
  const prdIds = [...new Set(propositions.map((p) => p.prd_id))];
  for (const id of prdIds) {
    const content = getPrdContent(db, id);
    if (content) {
      const table = extractChangesInScope(content);
      if (table) return "\n\n## Changes in scope\n\n" + table;
    }
  }
  return "";
}

const CONSTRAINTS_BLOCK = `\n\n## Constraints

- Do not run \`git commit\`, \`git reset\`, \`git checkout\`, \`git merge\`, \`git rebase\`, \`git push\`, or any other git commands that modify history or branch state. The orchestrator manages all commits.
- Make your changes as file edits. They will be committed at the end of the attempt.
- You may read git state freely: \`git status\`, \`git diff\`, \`git log\`, \`git show\`, \`git blame\`, etc.`;

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
  const gitDiffFromBase = deps?.gitDiffFromBase ?? defaultGitDiffFromBase;
  const findTestFiles = deps?.findTestFiles ?? defaultFindTestFiles;

  const propDetails = getPropositionDetails(db, task.proposition_ids);
  const propTexts = propDetails.map((p) => p.text);

  // Common blocks shared across phases
  const taskBlock = `## Task\n\n${task.title}`;
  const background = backgroundBlock(db, propDetails);
  const criteria = acceptanceCriteriaBlock(propTexts);
  const changesScope = changesInScopeBlock(db, propDetails);

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
        `${taskBlock}\n\n${background}\n\n${criteria}${changesScope}${fileList}${CONSTRAINTS_BLOCK}\n\n` +
        "Write tests covering the acceptance criteria above. " +
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
      const isRetry = attempt
        ? isRetryAttempt(db, attempt.attempt_id)
        : false;

      for (const f of testAuthorFiles) {
        files.push({ path: f, bytes: 0 });
      }

      const gateBlock = gateFailures
        ? `\n\n## Failing Gates\n\n\`\`\`\n${gateFailures}\n\`\`\``
        : "";
      const feedbackBlock = formatRetryFeedback(retryFeedback);

      let prevDiffBlock = "";
      if (isRetry) {
        const accumulatedDiff = await gitDiffFromBase(worktree_path, task.base_sha);
        if (accumulatedDiff) {
          prevDiffBlock = `\n\n## Existing Changes on Branch\n\nThese changes were made by previous attempts. Review them to understand what has already been done — do NOT assume they are correct or complete.\n\n\`\`\`diff\n${accumulatedDiff}\n\`\`\``;
        }
      }

      const fileList =
        testAuthorFiles.length > 0
          ? "\n\n## Test Files to Make Pass\n\n" +
            testAuthorFiles.map((f) => `- ${f}`).join("\n")
          : "";

      prompt =
        `${taskBlock}\n\n${background}\n\n${criteria}${changesScope}${gateBlock}${feedbackBlock}${prevDiffBlock}${fileList}${CONSTRAINTS_BLOCK}\n\n` +
        "## Instructions\n\n" +
        "You MUST implement ALL of the acceptance criteria listed above. " +
        "Do not stop until every criterion is addressed with working code. " +
        "Do not fix unrelated issues — stay focused on the task.\n\n" +
        "Before finishing, review the acceptance criteria checklist and confirm each one is satisfied by your changes. " +
        "If a criterion is not yet met, continue working.\n\n" +
        "If test files are listed above, make them pass. Otherwise, use the Background and Changes in scope sections " +
        "to identify which files to modify and write the implementation.";
      break;
    }

    case "auditor": {
      // Use the full diff from base_sha so the auditor sees all accumulated
      // changes, not just the current attempt's unstaged edits.
      const diff = task.base_sha
        ? await gitDiffFromBase(worktree_path, task.base_sha)
        : await gitDiff(worktree_path);
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
        `${taskBlock}\n\n${background}\n\n${criteria}${diffBlock}${feedbackBlock}\n\n` +
        "Review the changes against the acceptance criteria. " +
        "Use the Background section to judge whether the implementation is reasonable in the intended frame. " +
        "Return your verdict as JSON conforming to the schema in the system prompt.";
      break;
    }

    default: {
      prompt = `${taskBlock}\n\n${background}\n\n${criteria}\n\nComplete the task as described.`;
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

  // Resolve system prompt file for phases that have one
  let system_prompt_file: string | undefined;
  if (phase_name === "implementer" || phase_name === "test-author") {
    const candidate = path.resolve(worktree_path, "prompts", "implementer-v1.md");
    if (fs.existsSync(candidate)) {
      system_prompt_file = candidate;
    }
  }

  return { prompt, manifest, manifest_hash, system_prompt_file };
}
