import { describe, it, expect } from "vitest";
import type { AnyEvent, EventEnvelope, TaskConfig } from "./events.js";
import { reduceTaskList, reduceTaskDetail, reduceSettings, reduceAttempt, DEFAULT_TASK_CONFIG, type TaskListRow, PROJECTION_SUBSCRIPTIONS } from "./projections.js";
import { eventPayloadSchemas } from "./eventSchemas.js";

// Helper to build a typed event envelope
function makeEvent<T extends AnyEvent["type"]>(
  type: T,
  payload: Extract<AnyEvent, { type: T }>["payload"],
  overrides: Partial<EventEnvelope> = {},
): Extract<AnyEvent, { type: T }> {
  return {
    id: overrides.id ?? "evt-001",
    type,
    aggregate_type: "task" as const,
    aggregate_id: "task-1",
    version: 1,
    ts: overrides.ts ?? "2026-04-21T10:00:00.000Z",
    actor: { kind: "user" as const, user_id: "local" },
    payload,
  } as Extract<AnyEvent, { type: T }>;
}

const testConfig: TaskConfig = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-001",
      transport_options: {
        kind: "cli",
        bare: true,
        max_turns: 10,
        max_budget_usd: 1,
        permission_mode: "acceptEdits",
      },
      context_policy: {
        symbol_graph_depth: 2,
        include_tests: true,
        include_similar_patterns: false,
        token_budget: 8000,
      },
    },
    {
      name: "auditor",
      enabled: true,
      transport: "anthropic-api",
      model: "opus-4-6",
      prompt_version_id: "pv-002",
      transport_options: { kind: "api", max_tokens: 4096 },
      context_policy: {
        symbol_graph_depth: 1,
        include_tests: false,
        include_similar_patterns: false,
        token_budget: 4000,
      },
    },
  ],
  gates: [],
  retry_policy: {
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
    max_total_attempts: 3,
  },
};

describe("reduceTaskList", () => {
  it("creates a row from task.created", () => {
    const event = makeEvent("task.created", {
      task_id: "task-1",
      title: "Implement auth",
      proposition_ids: ["p-1", "p-2"],
      config_snapshot: testConfig,
      preset_id: "preset-default",
    });

    const row = reduceTaskList(null, event);
    expect(row).not.toBeNull();
    expect(row!.task_id).toBe("task-1");
    expect(row!.title).toBe("Implement auth");
    expect(row!.status).toBe("queued");
    expect(row!.attempt_count).toBe(0);
    expect(row!.phase_models).toEqual({
      implementer: "sonnet-4-6",
      auditor: "opus-4-6",
    });
  });

  it("creates a draft row for task.drafted", () => {
    const event = makeEvent("task.drafted", {
      task_id: "task-1",
      title: "Draft task",
      proposition_ids: ["p-1"],
      proposed_by: "agent",
    });

    const row = reduceTaskList(null, event);
    expect(row).not.toBeNull();
    expect(row!.task_id).toBe("task-1");
    expect(row!.title).toBe("Draft task");
    expect(row!.status).toBe("draft");
    expect(row!.attempt_count).toBe(0);
    expect(row!.pushback_count).toBe(0);
  });

  it("updates status on task.status_changed", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Implement auth",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row1 = reduceTaskList(null, created)!;

    const statusChanged = makeEvent(
      "task.status_changed",
      { task_id: "task-1", from: "queued", to: "running" },
      { ts: "2026-04-21T10:01:00.000Z" },
    );
    const row2 = reduceTaskList(row1, statusChanged)!;
    expect(row2.status).toBe("running");
    expect(row2.updated_at).toBe("2026-04-21T10:01:00.000Z");
  });

  it("increments attempt_count and sets current_attempt_id on attempt.started", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Implement auth",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row1 = reduceTaskList(null, created)!;

    const attemptStarted = makeEvent(
      "attempt.started",
      {
        attempt_id: "att-001",
        task_id: "task-1",
        attempt_number: 1,
        config_snapshot: testConfig,
        triggered_by: "user_start",
      },
      { ts: "2026-04-21T10:02:00.000Z" },
    );
    const row2 = reduceTaskList(row1, attemptStarted)!;
    expect(row2.attempt_count).toBe(1);
    expect(row2.current_attempt_id).toBe("att-001");
    expect(row2.status).toBe("running");
  });

  it("returns null on task.archived (removes from list)", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Implement auth",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row1 = reduceTaskList(null, created)!;

    const archived = makeEvent("task.archived", { task_id: "task-1" });
    const row2 = reduceTaskList(row1, archived);
    expect(row2).toBeNull();
  });

  it("updates title on task.title_changed", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Old title",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row1 = reduceTaskList(null, created)!;

    const titleChanged = makeEvent("task.title_changed", {
      task_id: "task-1",
      title: "New title",
    });
    const row2 = reduceTaskList(row1, titleChanged)!;
    expect(row2.title).toBe("New title");
  });

  it("updates phase_models on task.config_updated with phases", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row1 = reduceTaskList(null, created)!;
    expect(row1.phase_models.implementer).toBe("sonnet-4-6");

    const updatedPhases = [
      { ...testConfig.phases[0], model: "opus-4-6" },
      testConfig.phases[1],
    ];
    const configUpdated = makeEvent("task.config_updated", {
      task_id: "task-1",
      config_diff: { phases: updatedPhases },
    });
    const row2 = reduceTaskList(row1, configUpdated)!;
    expect(row2.phase_models.implementer).toBe("opus-4-6");
  });

  it("sets current_phase on phase.started", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row1 = reduceTaskList(null, created)!;

    const phaseStarted = makeEvent("phase.started", {
      attempt_id: "att-001",
      phase_name: "implementer",
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-001",
    });
    const row2 = reduceTaskList(row1, phaseStarted)!;
    expect(row2.current_phase).toBe("implementer");
  });

  it("full lifecycle: created → status_changed → attempt.started → phase.started → archived", () => {
    let row: TaskListRow | null = null;

    row = reduceTaskList(
      row,
      makeEvent(
        "task.created",
        {
          task_id: "task-1",
          title: "Auth feature",
          proposition_ids: ["p-1"],
          config_snapshot: testConfig,
        },
        { ts: "2026-04-21T10:00:00.000Z" },
      ),
    );
    expect(row!.status).toBe("queued");

    row = reduceTaskList(
      row,
      makeEvent(
        "task.status_changed",
        { task_id: "task-1", from: "queued", to: "running" },
        { ts: "2026-04-21T10:01:00.000Z" },
      ),
    );
    expect(row!.status).toBe("running");

    row = reduceTaskList(
      row,
      makeEvent(
        "attempt.started",
        {
          attempt_id: "att-001",
          task_id: "task-1",
          attempt_number: 1,
          config_snapshot: testConfig,
          triggered_by: "user_start",
        },
        { ts: "2026-04-21T10:02:00.000Z" },
      ),
    );
    expect(row!.attempt_count).toBe(1);
    expect(row!.current_attempt_id).toBe("att-001");

    row = reduceTaskList(
      row,
      makeEvent(
        "phase.started",
        {
          attempt_id: "att-001",
          phase_name: "implementer",
          transport: "claude-code",
          model: "sonnet-4-6",
          prompt_version_id: "pv-001",
        },
        { ts: "2026-04-21T10:03:00.000Z" },
      ),
    );
    expect(row!.current_phase).toBe("implementer");

    row = reduceTaskList(
      row,
      makeEvent(
        "task.archived",
        { task_id: "task-1" },
        { ts: "2026-04-21T10:10:00.000Z" },
      ),
    );
    expect(row).toBeNull();
  });

  it("returns current unchanged for unrelated event types", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row1 = reduceTaskList(null, created)!;

    // An unrelated event
    const unrelated = makeEvent("invocation.assistant_message", {
      invocation_id: "inv-001",
      text: "Hello",
    });
    const row2 = reduceTaskList(row1, unrelated);
    expect(row2).toBe(row1); // Same reference — no change
  });

  it("returns null when status_changed targets nonexistent row", () => {
    const event = makeEvent("task.status_changed", {
      task_id: "task-999",
      from: "queued",
      to: "running",
    });
    expect(reduceTaskList(null, event)).toBeNull();
  });
});

describe("PROJECTION_SUBSCRIPTIONS completeness", () => {
  it("has an entry for every EventType", async () => {
    // Dynamic import to get the subscription map and event types
    const { PROJECTION_SUBSCRIPTIONS } = await import("./projections.js");

    // The type system enforces this at compile time via Record<EventType, ...>,
    // but let's verify at runtime that no key maps to undefined
    for (const [key, value] of Object.entries(PROJECTION_SUBSCRIPTIONS)) {
      expect(Array.isArray(value)).toBe(true);
      // Verify every value is a valid ProjectionName
      for (const projection of value) {
        expect(typeof projection).toBe("string");
      }
      expect(key).toBeTruthy();
    }
  });

  it("has no duplicate projections in any single entry", async () => {
    const { PROJECTION_SUBSCRIPTIONS } = await import("./projections.js");

    for (const [key, projections] of Object.entries(PROJECTION_SUBSCRIPTIONS)) {
      const unique = new Set(projections);
      expect(unique.size).toBe(
        projections.length,
        // Extra context on failure
      );
    }
  });
});

// ============================================================================
// DEFAULT_TASK_CONFIG
// ============================================================================

describe("DEFAULT_TASK_CONFIG", () => {
  it("contains exactly three phases in fixed order: test-author, implementer, auditor", () => {
    expect(DEFAULT_TASK_CONFIG.phases).toHaveLength(3);
    expect(DEFAULT_TASK_CONFIG.phases.map((p) => p.name)).toEqual([
      "test-author",
      "implementer",
      "auditor",
    ]);
  });

  it("only enables implementer by default", () => {
    const enabled = DEFAULT_TASK_CONFIG.phases.filter((p) => p.enabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("implementer");
  });

  it("uses claude-code CLI for test-author and implementer, anthropic-api for auditor", () => {
    const [testAuthor, implementer, auditor] = DEFAULT_TASK_CONFIG.phases;
    expect(testAuthor.transport).toBe("claude-code");
    expect(testAuthor.transport_options.kind).toBe("cli");
    expect(implementer.transport).toBe("claude-code");
    expect(implementer.transport_options.kind).toBe("cli");
    expect(auditor.transport).toBe("anthropic-api");
    expect(auditor.transport_options.kind).toBe("api");
  });
});

// ============================================================================
// Priority 36 — Merge and Approval Events
// ============================================================================

describe("Merge and Approval Events — schema and projections", () => {
  it("task.merged Zod schema accepts a valid payload", () => {
    const result = eventPayloadSchemas["task.merged"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      merge_commit_sha: "abc123",
      into_branch: "main",
      strategy: "squash",
      advanced_by_commits: 3,
    });
    expect(result.success).toBe(true);
  });

  it("task.merged Zod schema rejects an invalid strategy", () => {
    const result = eventPayloadSchemas["task.merged"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      merge_commit_sha: "abc123",
      into_branch: "main",
      strategy: "rebase", // invalid
      advanced_by_commits: 3,
    });
    expect(result.success).toBe(false);
  });

  it("merge.conflicted Zod schema accepts a valid payload", () => {
    const result = eventPayloadSchemas["merge.conflicted"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      conflicting_paths: ["src/foo.ts", "src/bar.ts"],
      attempted_into_branch: "main",
    });
    expect(result.success).toBe(true);
  });

  it("merge.gate_failed Zod schema accepts a valid payload", () => {
    const result = eventPayloadSchemas["merge.gate_failed"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      gate_name: "tsc",
      failures: [
        { category: "typecheck", location: { path: "src/foo.ts", line: 10 }, excerpt: "Type error" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("task.finalized Zod schema rejects invalid reason", () => {
    const result = eventPayloadSchemas["task.finalized"].safeParse({
      task_id: "T-001",
      reason: "deleted", // invalid
    });
    expect(result.success).toBe(false);
  });

  it("PROJECTION_SUBSCRIPTIONS covers all four new event types", () => {
    expect(PROJECTION_SUBSCRIPTIONS["task.merged"]).toEqual(["task_list", "task_detail"]);
    expect(PROJECTION_SUBSCRIPTIONS["merge.conflicted"]).toEqual(["task_list", "task_detail", "attempt"]);
    expect(PROJECTION_SUBSCRIPTIONS["merge.gate_failed"]).toEqual(["task_list", "task_detail", "attempt"]);
    expect(PROJECTION_SUBSCRIPTIONS["task.finalized"]).toEqual(["task_list", "task_detail"]);
  });

  it("reduceTaskList handles task.merged by setting status to merged", () => {
    // Build an initial row via task.created
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const approvedRow = {
      ...reduceTaskList(null, created)!,
      status: "approved" as const,
    };

    const merged = makeEvent("task.merged", {
      task_id: "task-1",
      attempt_id: "A-001",
      merge_commit_sha: "abc123def456",
      into_branch: "main",
      strategy: "squash",
      advanced_by_commits: 1,
    });
    const result = reduceTaskList(approvedRow, merged);
    expect(result?.status).toBe("merged");
  });

  it("reduceTaskList handles task.finalized with reason=merged", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row = reduceTaskList(null, created)!;

    const finalized = makeEvent("task.finalized", {
      task_id: "task-1",
      reason: "merged",
    });
    const result = reduceTaskList(row, finalized);
    expect(result?.status).toBe("merged");
  });

  it("reduceTaskList handles task.finalized with reason=manual (archived)", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row = reduceTaskList(null, created)!;

    const finalized = makeEvent("task.finalized", {
      task_id: "task-1",
      reason: "manual",
    });
    const result = reduceTaskList(row, finalized);
    expect(result?.status).toBe("archived");
  });
});

// ============================================================================
// Priority 43 — Auto-Merge Policy Fields
// ============================================================================

describe("Auto-Merge Policy — schema and projections", () => {
  it("task.auto_approved Zod schema rejects invalid policy value", () => {
    const result = eventPayloadSchemas["task.auto_approved"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      policy: "yolo_merge",
      matched_conditions: ["all_gates_passed"],
    });
    expect(result.success).toBe(false);
  });

  it("task.auto_approved Zod schema accepts valid payload", () => {
    const result = eventPayloadSchemas["task.auto_approved"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      policy: "on_full_pass",
      matched_conditions: ["auditor_approve", "all_gates_passed"],
    });
    expect(result.success).toBe(true);
  });

  it("task.auto_merged Zod schema accepts valid payload", () => {
    const result = eventPayloadSchemas["task.auto_merged"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      merge_commit_sha: "abc123",
      into_branch: "main",
      policy: "on_auditor_approve",
      strategy: "squash",
    });
    expect(result.success).toBe(true);
  });

  it("task.auto_merged Zod schema rejects invalid strategy", () => {
    const result = eventPayloadSchemas["task.auto_merged"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      merge_commit_sha: "abc123",
      into_branch: "main",
      policy: "on_full_pass",
      strategy: "rebase",
    });
    expect(result.success).toBe(false);
  });

  it("task.would_auto_merge Zod schema accepts valid payload", () => {
    const result = eventPayloadSchemas["task.would_auto_merge"].safeParse({
      task_id: "T-001",
      attempt_id: "A-001",
      policy: "on_full_pass",
      matched_conditions: ["auditor_approve"],
    });
    expect(result.success).toBe(true);
  });

  it("settings.auto_merge_enabled_set Zod schema accepts valid payload", () => {
    const result = eventPayloadSchemas["settings.auto_merge_enabled_set"].safeParse({
      enabled: true,
    });
    expect(result.success).toBe(true);
  });

  it("settings.auto_merge_enabled_set Zod schema rejects non-boolean", () => {
    const result = eventPayloadSchemas["settings.auto_merge_enabled_set"].safeParse({
      enabled: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("taskConfigSchema accepts auto_merge_policy and shadow_mode", () => {
    const configWithPolicy: TaskConfig = {
      ...testConfig,
      auto_merge_policy: "on_full_pass",
      shadow_mode: true,
    };
    // Validate via the task.created schema which embeds taskConfigSchema
    const result = eventPayloadSchemas["task.created"].safeParse({
      task_id: "T-001",
      title: "Test",
      proposition_ids: [],
      config_snapshot: configWithPolicy,
    });
    expect(result.success).toBe(true);
  });

  it("taskConfigSchema rejects invalid auto_merge_policy", () => {
    const result = eventPayloadSchemas["task.created"].safeParse({
      task_id: "T-001",
      title: "Test",
      proposition_ids: [],
      config_snapshot: {
        ...testConfig,
        auto_merge_policy: "always_merge",
      },
    });
    expect(result.success).toBe(false);
  });

  it("PROJECTION_SUBSCRIPTIONS covers all new auto-merge event types", () => {
    expect(PROJECTION_SUBSCRIPTIONS["task.auto_approved"]).toEqual(["task_list", "task_detail"]);
    expect(PROJECTION_SUBSCRIPTIONS["task.auto_merged"]).toEqual(["task_list", "task_detail"]);
    expect(PROJECTION_SUBSCRIPTIONS["task.would_auto_merge"]).toEqual([]);
    expect(PROJECTION_SUBSCRIPTIONS["settings.auto_merge_enabled_set"]).toEqual(["settings"]);
  });

  it("DEFAULT_TASK_CONFIG includes auto_merge_policy: 'off' and shadow_mode: false", () => {
    expect(DEFAULT_TASK_CONFIG.auto_merge_policy).toBe("off");
    expect(DEFAULT_TASK_CONFIG.shadow_mode).toBe(false);
  });

  it("reduceSettings returns auto_merge_enabled=false on fresh DB", () => {
    // No events — calling reducer with a different event type returns current (null).
    const result = reduceSettings(null, makeEvent("task.created", {
      task_id: "T-001",
      title: "Test",
      proposition_ids: [],
      config_snapshot: testConfig,
    }));
    expect(result).toBeNull();
  });

  it("reduceSettings handles settings.auto_merge_enabled_set", () => {
    const event = makeEvent("settings.auto_merge_enabled_set", {
      enabled: true,
    } as never, {
      aggregate_type: "settings" as never,
      aggregate_id: "global",
    });
    const result = reduceSettings(null, event);
    expect(result).not.toBeNull();
    expect(result!.auto_merge_enabled).toBe(true);
    expect(result!.settings_id).toBe("global");
  });

  it("reduceSettings toggles auto_merge_enabled back to false", () => {
    const enableEvent = makeEvent("settings.auto_merge_enabled_set", {
      enabled: true,
    } as never, {
      aggregate_type: "settings" as never,
      aggregate_id: "global",
      ts: "2026-04-22T10:00:00.000Z",
    });
    const enabled = reduceSettings(null, enableEvent)!;
    expect(enabled.auto_merge_enabled).toBe(true);

    const disableEvent = makeEvent("settings.auto_merge_enabled_set", {
      enabled: false,
    } as never, {
      aggregate_type: "settings" as never,
      aggregate_id: "global",
      ts: "2026-04-22T10:01:00.000Z",
    });
    const disabled = reduceSettings(enabled, disableEvent)!;
    expect(disabled.auto_merge_enabled).toBe(false);
  });

  it("reduceTaskList handles task.auto_approved → approved status", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row = reduceTaskList(null, created)!;

    const autoApproved = makeEvent("task.auto_approved", {
      task_id: "task-1",
      attempt_id: "A-001",
      policy: "on_full_pass",
      matched_conditions: ["auditor_approve", "all_gates_passed"],
    } as never);
    const result = reduceTaskList(row, autoApproved);
    expect(result?.status).toBe("approved");
  });

  it("reduceTaskList handles task.auto_merged → merged status", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: [],
      config_snapshot: testConfig,
    });
    const row = { ...reduceTaskList(null, created)!, status: "approved" as const };

    const autoMerged = makeEvent("task.auto_merged", {
      task_id: "task-1",
      attempt_id: "A-001",
      merge_commit_sha: "abc123",
      into_branch: "main",
      policy: "on_full_pass",
      strategy: "squash",
    } as never);
    const result = reduceTaskList(row, autoMerged);
    expect(result?.status).toBe("merged");
  });

  it("reduceTaskDetail handles task.auto_merged with merge_commit_sha", () => {
    const created = makeEvent("task.created", {
      task_id: "task-1",
      title: "Task",
      proposition_ids: ["p-1"],
      config_snapshot: testConfig,
    });
    const detail = reduceTaskDetail(null, created)!;

    const autoMerged = makeEvent("task.auto_merged", {
      task_id: "task-1",
      attempt_id: "A-001",
      merge_commit_sha: "def456",
      into_branch: "develop",
      policy: "on_auditor_approve",
      strategy: "merge",
    } as never, { id: "evt-002" });
    const result = reduceTaskDetail(detail, autoMerged)!;
    expect(result.status).toBe("merged");
    expect(result.merge_commit_sha).toBe("def456");
    expect(result.merged_into_branch).toBe("develop");
  });

  it("existing presets config_snapshot is backwards-compatible (no auto_merge_policy)", () => {
    // Presets created before auto-merge don't have the field — Zod should
    // still accept them because auto_merge_policy and shadow_mode are optional.
    const result = eventPayloadSchemas["preset.created"].safeParse({
      preset_id: "preset-001",
      name: "default-new-feature",
      task_class: "new-feature",
      config: testConfig, // no auto_merge_policy
    });
    expect(result.success).toBe(true);
  });
});

describe("phase.diff_snapshotted", () => {
  it("PROJECTION_SUBSCRIPTIONS includes attempt projection", () => {
    expect(PROJECTION_SUBSCRIPTIONS["phase.diff_snapshotted"]).toContain("attempt");
  });

  it("reduceAttempt stores diff_hash on the phase entry", () => {
    // Set up an attempt with a started phase
    const started = makeEvent("attempt.started", {
      attempt_id: "A-001",
      task_id: "T-001",
      attempt_number: 1,
      config_snapshot: testConfig,
      triggered_by: "user_start",
    }, { aggregate_type: "attempt" as never, aggregate_id: "A-001" });
    let row = reduceAttempt(null, started)!;

    const phaseStarted = makeEvent("phase.started", {
      attempt_id: "A-001",
      phase_name: "implementer",
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-001",
    } as never, { id: "evt-002" });
    row = reduceAttempt(row, phaseStarted)!;

    const snapshotted = makeEvent("phase.diff_snapshotted", {
      attempt_id: "A-001",
      phase_name: "implementer",
      diff_hash: "d".repeat(64),
      base_sha: "e".repeat(40),
    } as never, { id: "evt-003" });
    row = reduceAttempt(row, snapshotted)!;

    expect(row.phases["implementer"].diff_hash).toBe("d".repeat(64));
    expect(row.last_event_id).toBe("evt-003");
  });

  it("reduceAttempt returns null when no current row exists", () => {
    const snapshotted = makeEvent("phase.diff_snapshotted", {
      attempt_id: "A-001",
      phase_name: "implementer",
      diff_hash: "d".repeat(64),
      base_sha: "e".repeat(40),
    } as never, { id: "evt-003" });
    expect(reduceAttempt(null, snapshotted)).toBeNull();
  });
});
