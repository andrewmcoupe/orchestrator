import { describe, it, expect } from "vitest";
import { eventPayloadSchemas } from "./eventSchemas.js";

describe("prd.ingested schema", () => {
  const schema = eventPayloadSchemas["prd.ingested"];

  const base = {
    prd_id: "01J000000000000000000000",
    size_bytes: 1024,
    lines: 42,
    extractor_model: "claude-sonnet-4-6",
    extractor_prompt_version_id: "pv-001",
    content_hash: "abc123",
    content: "# My PRD\n\nSome content here.",
  };

  it("accepts path as string", () => {
    const result = schema.safeParse({ ...base, path: "/tmp/prd.md" });
    expect(result.success).toBe(true);
  });

  it("accepts path as null", () => {
    const result = schema.safeParse({ ...base, path: null });
    expect(result.success).toBe(true);
  });

  it("requires content as string", () => {
    const result = schema.safeParse({ ...base, path: "/tmp/prd.md" });
    expect(result.success).toBe(true);
    expect(result.data.content).toBe(base.content);
  });

  it("rejects missing content", () => {
    const { content: _, ...noContent } = base;
    const result = schema.safeParse({ ...noContent, path: "/tmp/prd.md" });
    expect(result.success).toBe(false);
  });
});

describe("task.dependency.set schema", () => {
  const schema = eventPayloadSchemas["task.dependency.set"];

  it("accepts task_id and depends_on array", () => {
    const result = schema.safeParse({
      task_id: "01J000000000000000000001",
      depends_on: ["01J000000000000000000002", "01J000000000000000000003"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty depends_on array", () => {
    const result = schema.safeParse({
      task_id: "01J000000000000000000001",
      depends_on: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing task_id", () => {
    const result = schema.safeParse({
      depends_on: ["01J000000000000000000002"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing depends_on", () => {
    const result = schema.safeParse({
      task_id: "01J000000000000000000001",
    });
    expect(result.success).toBe(false);
  });
});

describe("task.unblocked schema", () => {
  const schema = eventPayloadSchemas["task.unblocked"];

  it("accepts task_id", () => {
    const result = schema.safeParse({
      task_id: "01J000000000000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing task_id", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("attempt.committed schema", () => {
  const schema = eventPayloadSchemas["attempt.committed"];

  const valid = {
    attempt_id: "01J000000000000000000001",
    commit_sha: "a".repeat(40),
    empty: false,
  };

  it("accepts valid payload", () => {
    const result = schema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts empty: true", () => {
    const result = schema.safeParse({ ...valid, empty: true });
    expect(result.success).toBe(true);
  });

  it("rejects missing attempt_id", () => {
    const { attempt_id: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing commit_sha", () => {
    const { commit_sha: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing empty", () => {
    const { empty: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });
});

describe("phase.diff_snapshotted schema", () => {
  const schema = eventPayloadSchemas["phase.diff_snapshotted"];

  const valid = {
    attempt_id: "01J000000000000000000001",
    phase_name: "implementer",
    diff_hash: "b".repeat(64),
    base_sha: "c".repeat(40),
  };

  it("accepts valid payload", () => {
    const result = schema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts different phase names", () => {
    const result = schema.safeParse({ ...valid, phase_name: "test-author" });
    expect(result.success).toBe(true);
  });

  it("rejects missing attempt_id", () => {
    const { attempt_id: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing phase_name", () => {
    const { phase_name: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing diff_hash", () => {
    const { diff_hash: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing base_sha", () => {
    const { base_sha: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });
});

describe("task.worktree_created schema", () => {
  const schema = eventPayloadSchemas["task.worktree_created"];

  const valid = {
    task_id: "01J000000000000000000001",
    path: "/tmp/worktrees/01J000000000000000000001",
    branch: "wt/01J000000000000000000001",
    base_ref: "main",
    base_sha: "a".repeat(40),
  };

  it("accepts valid payload with base_ref and base_sha", () => {
    const result = schema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("preserves base_ref unchanged", () => {
    const result = schema.safeParse(valid);
    expect(result.success).toBe(true);
    expect(result.data.base_ref).toBe("main");
  });

  it("requires base_sha", () => {
    const { base_sha: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing base_ref", () => {
    const { base_ref: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing task_id", () => {
    const { task_id: _, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });
});
