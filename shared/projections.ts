/**
 * Projections — the read side of the orchestrator.
 *
 * Events are the source of truth. Projections are denormalized views built
 * by folding events with pure reducers. They exist to make UI queries fast
 * without traversing the event log every time.
 *
 * Update model: when an event is appended, every subscribed projection is
 * updated in the SAME SQLite transaction. Consistency is guaranteed by
 * co-locating event writes and projection updates.
 *
 * Rebuild model: every projection is rebuildable from events. Each projection
 * tracks a "last_event_id" watermark. To rebuild: delete the table, reset
 * the watermark to the earliest event, replay. This is the escape hatch for
 * projection logic changes.
 *
 * Client model: the UI loads projections via REST on mount, then subscribes
 * to events via SSE. The client folds events into its local store using the
 * SAME reducer logic the server uses. Server and client stay in sync
 * because they run the same reducers over the same event stream.
 *
 * Every projection below is justified by a specific UI surface. If a
 * projection has no consumer, delete it.
 */

import type {
  AnyEvent,
  EventType,
  TaskConfig,
  TaskStatus,
  PhaseName,
  Transport,
  AuditConcern,
  GateConfig,
  ExitReason,
} from "./events.js";

// ============================================================================
// Default task config — shared between server commands and projections
// ============================================================================

export const DEFAULT_TASK_CONFIG: TaskConfig = {
  phases: [
    {
      name: "test-author",
      enabled: false,
      transport: "claude-code",
      model: "claude-sonnet-4-6",
      prompt_version_id: "default",
      transport_options: {
        kind: "cli",
        max_budget_usd: 5,
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
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "claude-sonnet-4-6",
      prompt_version_id: "default",
      transport_options: {
        kind: "cli",
        max_budget_usd: 5,
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
      enabled: false,
      transport: "anthropic-api",
      model: "claude-sonnet-4-6",
      prompt_version_id: "default",
      transport_options: {
        kind: "api",
        max_tokens: 4096,
      },
      context_policy: {
        symbol_graph_depth: 2,
        include_tests: true,
        include_similar_patterns: false,
        token_budget: 8000,
      },
    },
  ],
  gates: [],
  retry_policy: {
    max_total_attempts: 3,
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
    on_exit_reason: {
      permission_blocked: "escalate_to_human",
      budget_exceeded: "escalate_to_human",
      timeout: "retry_same",
      network_error: "retry_same",
      schema_invalid: "retry_same",
      turn_limit: "escalate_to_human",
      killed: "escalate_to_human",
      crashed: "escalate_to_human",
      unknown: "escalate_to_human",
    },
  },
  auto_merge_policy: "off",
  shadow_mode: false,
};

// ============================================================================
// Watermarks
// ============================================================================

/**
 * Each projection tracks how far it's processed. On startup, each projection
 * reads its watermark and catches up from there. Rebuilds reset to zero.
 *
 * SQL:
 *   CREATE TABLE projection_watermarks (
 *     projection_name TEXT PRIMARY KEY,
 *     last_event_id  TEXT NOT NULL,
 *     updated_at     TEXT NOT NULL
 *   );
 */
export interface ProjectionWatermark {
  projection_name: ProjectionName;
  last_event_id: string;
  updated_at: string;
}

export type ProjectionName =
  | "task_list"
  | "task_detail"
  | "proposition"
  | "attempt"
  | "provider_health"
  | "prompt_library"
  | "ab_experiment"
  | "cost_rollup"
  | "preset"
  | "settings"
  | "gate_library";

// ============================================================================
// TaskListProjection — the cockpit sidebar
// ============================================================================

/**
 * Consumers: cockpit left sidebar (task list), PRD group headers, task count
 * badges. One row per live task.
 *
 * Query patterns:
 *   - SELECT * FROM proj_task_list WHERE prd_id = ? ORDER BY updated_at DESC
 *   - SELECT * FROM proj_task_list WHERE status IN (?) ORDER BY updated_at DESC
 *
 * SQL:
 *   CREATE TABLE proj_task_list (
 *     task_id            TEXT PRIMARY KEY,
 *     prd_id             TEXT,
 *     title              TEXT NOT NULL,
 *     status             TEXT NOT NULL,
 *     current_phase      TEXT,
 *     current_attempt_id TEXT,
 *     attempt_count      INTEGER NOT NULL DEFAULT 0,
 *     pushback_count     INTEGER NOT NULL DEFAULT 0,
 *     phase_models_json  TEXT,   -- denormalized for sidebar display
 *     last_event_ts      TEXT NOT NULL,
 *     updated_at         TEXT NOT NULL
 *   );
 *   CREATE INDEX idx_task_list_prd     ON proj_task_list(prd_id);
 *   CREATE INDEX idx_task_list_status  ON proj_task_list(status);
 *   CREATE INDEX idx_task_list_updated ON proj_task_list(updated_at DESC);
 */
export interface TaskListRow {
  task_id: string;
  prd_id?: string;
  title: string;
  status: TaskStatus;
  current_phase?: PhaseName;
  current_attempt_id?: string;
  attempt_count: number;
  pushback_count: number;
  /** Phase name → model string. Denormalized so the sidebar doesn't have to join. */
  phase_models: Record<string, string>;
  /** True if this task was auto-merged (vs manual merge). */
  auto_merged?: boolean;
  /** Task IDs this task depends on. Empty array means no dependencies. */
  depends_on?: string[];
  /** True if this task has unmet dependencies. */
  blocked?: boolean;
  last_event_ts: string;
  updated_at: string;
}

// ============================================================================
// TaskDetailProjection — cockpit detail pane, config modal reads
// ============================================================================

/**
 * Consumers: cockpit main pane, config modal (current state), review screen header.
 * One row per task. Fully denormalized for single-query reads.
 *
 * SQL:
 *   CREATE TABLE proj_task_detail (
 *     task_id                    TEXT PRIMARY KEY,
 *     prd_id                     TEXT,
 *     title                      TEXT NOT NULL,
 *     status                     TEXT NOT NULL,
 *     config_json                TEXT NOT NULL,
 *     preset_id                  TEXT,
 *     preset_override_keys_json  TEXT,
 *     proposition_ids_json       TEXT NOT NULL,
 *     worktree_path              TEXT,
 *     worktree_branch            TEXT,
 *     current_attempt_id         TEXT,
 *     last_event_id              TEXT NOT NULL,
 *     updated_at                 TEXT NOT NULL
 *   );
 */
export interface TaskDetailRow {
  task_id: string;
  prd_id?: string;
  title: string;
  status: TaskStatus;
  /** Live config — includes all overrides applied on top of the preset. */
  config: TaskConfig;
  preset_id?: string;
  /** Dotted paths of config keys that differ from the referenced preset. */
  preset_override_keys: string[];
  proposition_ids: string[];
  worktree_path?: string;
  worktree_branch?: string;
  /** Resolved commit SHA from task.worktree_created — immutable diff anchor for attempt 1. */
  base_sha?: string;
  current_attempt_id?: string;
  /** Set after a successful merge — the resulting commit sha */
  merge_commit_sha?: string;
  /** Set after a successful merge — the branch that was merged into */
  merged_into_branch?: string;
  last_event_id: string;
  updated_at: string;
}

// ============================================================================
// PropositionProjection — ingest screen, proposition references in reviews
// ============================================================================

/**
 * Consumers: ingest screen, auditor "reference proposition" links, task
 * detail's proposition list.
 *
 * SQL:
 *   CREATE TABLE proj_proposition (
 *     proposition_id          TEXT PRIMARY KEY,
 *     prd_id                  TEXT NOT NULL,
 *     text                    TEXT NOT NULL,
 *     source_section          TEXT,
 *     source_line_start       INTEGER,
 *     source_line_end         INTEGER,
 *     confidence              REAL NOT NULL,
 *     task_id                 TEXT,
 *     active_pushback_ids_json TEXT,
 *     updated_at              TEXT NOT NULL
 *   );
 *   CREATE INDEX idx_prop_prd  ON proj_proposition(prd_id);
 *   CREATE INDEX idx_prop_task ON proj_proposition(task_id);
 */
export interface PropositionRow {
  proposition_id: string;
  prd_id: string;
  text: string;
  source_span: { section: string; line_start: number; line_end: number };
  confidence: number;
  task_id?: string;
  /** Open (unresolved) pushback ids. Empty array means no live pushbacks. */
  active_pushback_ids: string[];
  updated_at: string;
}

// ============================================================================
// AttemptProjection — review screen, attempt history, measurement
// ============================================================================

/**
 * Consumers: review screen (latest attempt for a task), attempt history
 * view, measurement dashboards (via aggregation).
 *
 * Large JSON-heavy rows. One per attempt. Indexed by task_id so we can
 * cheaply get "all attempts for task T" and "latest attempt for task T".
 *
 * SQL:
 *   CREATE TABLE proj_attempt (
 *     attempt_id          TEXT PRIMARY KEY,
 *     task_id             TEXT NOT NULL,
 *     attempt_number      INTEGER NOT NULL,
 *     status              TEXT NOT NULL,
 *     outcome             TEXT,
 *     started_at          TEXT NOT NULL,
 *     completed_at        TEXT,
 *     duration_ms         INTEGER,
 *     tokens_in_total     INTEGER NOT NULL DEFAULT 0,
 *     tokens_out_total    INTEGER NOT NULL DEFAULT 0,
 *     cost_usd_total      REAL NOT NULL DEFAULT 0,
 *     phases_json         TEXT NOT NULL,  -- Record<PhaseName, PhaseRunSummary>
 *     gate_runs_json      TEXT NOT NULL,  -- GateRunSummary[]
 *     audit_json          TEXT,           -- AuditSummary | null
 *     files_changed_json  TEXT NOT NULL,  -- FileChangeSummary[]
 *     config_snapshot_json TEXT NOT NULL,
 *     previous_attempt_id TEXT,
 *     last_failure_reason TEXT,
 *     last_event_id       TEXT NOT NULL
 *   );
 *   CREATE INDEX idx_attempt_task     ON proj_attempt(task_id, attempt_number DESC);
 *   CREATE INDEX idx_attempt_outcome  ON proj_attempt(outcome) WHERE outcome IS NOT NULL;
 */
export interface AttemptRow {
  attempt_id: string;
  task_id: string;
  attempt_number: number;
  status: AttemptStatus;
  outcome?: "approved" | "rejected" | "revised" | "escalated" | "failed" | "no_changes";
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  tokens_in_total: number;
  tokens_out_total: number;
  cost_usd_total: number;
  phases: Record<string, PhaseRunSummary>;
  gate_runs: GateRunSummary[];
  audit?: AuditSummary;
  files_changed: FileChangeSummary[];
  config_snapshot: TaskConfig;
  previous_attempt_id?: string;
  commit_sha?: string;
  empty?: boolean;
  effective_diff_attempt_id?: string;
  /** Exit reason from the most recent phase.completed where exit_reason !== "normal". Null if no failure. */
  last_failure_reason?: ExitReason | null;
  last_event_id: string;
}

export type AttemptStatus = "running" | "paused" | "killed" | "completed";

export interface PhaseRunSummary {
  phase_name: PhaseName;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  model?: string;
  prompt_version_id?: string;
  ab_variant?: "A" | "B";
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  duration_ms?: number;
  context_manifest_hash?: string;
  /** SHA-256 hash of the unified diff captured at phase completion. */
  diff_hash?: string;
}

export interface GateRunSummary {
  gate_run_id: string;
  gate_name: string;
  status: "pending" | "running" | "passed" | "failed" | "timed_out" | "skipped";
  duration_ms?: number;
  failure_count?: number;
}

export interface AuditSummary {
  verdict: "approve" | "revise" | "reject";
  confidence: number;
  concern_count: number;
  blocking_count: number;
  concerns: AuditConcern[]; // full concerns for review screen rendering
  overridden: boolean;
}

export interface FileChangeSummary {
  path: string;
  operation: "create" | "update" | "delete";
  lines_added: number;
  lines_removed: number;
}

// ============================================================================
// ProviderHealthProjection — top-bar pills and providers section
// ============================================================================

/**
 * Consumers: top-bar provider pills (every section), Providers section detail.
 *
 * SQL:
 *   CREATE TABLE proj_provider_health (
 *     provider_id     TEXT PRIMARY KEY,
 *     transport       TEXT NOT NULL,
 *     status          TEXT NOT NULL,
 *     latency_ms      INTEGER,
 *     last_probe_at   TEXT,
 *     last_error      TEXT,
 *     models_json     TEXT,
 *     binary_path     TEXT,
 *     endpoint        TEXT,
 *     auth_method     TEXT,
 *     auth_present    INTEGER NOT NULL DEFAULT 0
 *   );
 */
export interface ProviderHealthRow {
  provider_id: string;
  transport: Transport;
  status: "healthy" | "degraded" | "down" | "unknown";
  latency_ms?: number;
  last_probe_at?: string;
  last_error?: string;
  models?: string[];
  binary_path?: string;
  endpoint?: string;
  auth_method?: "env_var" | "keychain" | "cli_login";
  auth_present: boolean;
}

// ============================================================================
// PromptLibraryProjection — prompts section
// ============================================================================

/**
 * Consumers: Prompts section library, prompt-version dropdowns in the config
 * modal. Includes rolling 30-day usage stats so the library can show which
 * prompts are actually being used and how they're performing.
 */
export interface PromptVersionRow {
  prompt_version_id: string;
  name: string;
  phase_class: PhaseName;
  template_hash: string;
  parent_version_id?: string;
  notes?: string;
  retired: boolean;
  invocations_last_30d: number;
  success_rate_last_30d?: number;
  avg_cost_usd?: number;
  ab_experiment_ids: string[];
  created_at: string;
}

// ============================================================================
// AbExperimentProjection — A/B results
// ============================================================================

export interface AbExperimentRow {
  experiment_id: string;
  phase_class: PhaseName;
  variant_a_id: string;
  variant_b_id: string;
  bucket_key: string;
  /** Weight for variant A (0–100). Determines the assignment split percentage. */
  split_a: number;
  a_n: number;
  a_success_n: number;
  a_cost_usd: number;
  b_n: number;
  b_success_n: number;
  b_cost_usd: number;
  a_success_rate: number;
  b_success_rate: number;
  /** Computed on read. Chi-squared or Fisher's exact depending on n. */
  significance_p?: number;
  status: "running" | "concluded";
  winner?: "A" | "B" | "none";
  /** Transient — set by projection read(), not persisted. Used to route stats updates. */
  _variant?: "A" | "B";
}

// ============================================================================
// CostRollupProjection — measurement section
// ============================================================================

/**
 * Daily aggregates. The measurement dashboards query this for trend lines
 * without scanning the event log or attempt projection.
 *
 * SQL:
 *   CREATE TABLE proj_cost_rollup (
 *     date             TEXT NOT NULL,         -- YYYY-MM-DD
 *     provider_id      TEXT NOT NULL,
 *     model            TEXT NOT NULL,
 *     phase_class      TEXT,
 *     invocation_count INTEGER NOT NULL DEFAULT 0,
 *     tokens_in        INTEGER NOT NULL DEFAULT 0,
 *     tokens_out       INTEGER NOT NULL DEFAULT 0,
 *     cost_usd         REAL NOT NULL DEFAULT 0,
 *     PRIMARY KEY (date, provider_id, model, phase_class)
 *   );
 */
export interface CostRollupRow {
  date: string;
  provider_id: string;
  model: string;
  phase_class?: PhaseName;
  invocation_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

// ============================================================================
// PresetProjection — config modal dropdown, settings presets view
// ============================================================================

export interface PresetRow {
  preset_id: string;
  name: string;
  task_class: string;
  config: TaskConfig;
  updated_at: string;
}

// ============================================================================
// GlobalSettingsRow — single row, settings_id = "global"
// ============================================================================

export interface GlobalSettingsRow {
  settings_id: "global";
  default_preset_id: string | null;
  auto_delete_worktree_on_merge: boolean;
  auto_pause_on_external_fs_change: boolean;
  /** Global kill switch for auto-merge. False by default. */
  auto_merge_enabled: boolean;
  updated_at: string;
}

// ============================================================================
// GateLibraryRow — one row per custom gate in the shared library
// ============================================================================

export interface GateLibraryRow {
  gate_name: string;
  command: string;
  required: boolean;
  timeout_seconds: number;
  on_fail: GateConfig["on_fail"];
  updated_at: string;
}

// ============================================================================
// EventFeedProjection — the live stream strip
// ============================================================================

/**
 * Not a separate projection — the events table IS the feed. Queried with:
 *
 *   -- global feed (last 100)
 *   SELECT * FROM events ORDER BY id DESC LIMIT 100
 *
 *   -- per-task feed (last 100 for this attempt)
 *   SELECT * FROM events WHERE correlation_id = ? ORDER BY id DESC LIMIT 100
 *
 * SSE is the primary path for live updates; these queries are only for
 * initial load when the UI mounts.
 */

// ============================================================================
// Example reducer: TaskListRow
// ============================================================================

/**
 * Reducers are pure functions of (current_row_or_null, event) → new_row_or_null.
 * Returning null deletes the row (or is a no-op if it didn't exist).
 *
 * In the runner: for each event, look up subscribed projections, for each
 * projection read the affected row, call the reducer, write the new row.
 * Everything in one SQLite transaction with the event append.
 */
export function reduceTaskList(
  current: TaskListRow | null,
  event: AnyEvent,
): TaskListRow | null {
  switch (event.type) {
    case "task.drafted":
      // Drafts appear in the sidebar with status=draft, created by ingest.
      if (current) return current; // idempotent
      return {
        task_id: event.payload.task_id,
        title: event.payload.title,
        status: "draft" as const,
        attempt_count: 0,
        pushback_count: 0,
        phase_models: {},
        last_event_ts: event.ts,
        updated_at: event.ts,
      };

    case "task.created": {
      const p = event.payload;
      return {
        task_id: p.task_id,
        title: p.title,
        status: "queued",
        attempt_count: 0,
        pushback_count: 0,
        phase_models: Object.fromEntries(
          p.config_snapshot.phases.map((ph) => [ph.name, ph.model]),
        ),
        last_event_ts: event.ts,
        updated_at: event.ts,
      };
    }

    case "task.title_changed":
      if (!current) return null;
      return { ...current, title: event.payload.title, updated_at: event.ts };

    case "task.status_changed":
      if (!current) return null;
      return { ...current, status: event.payload.to, updated_at: event.ts };

    case "task.archived":
      // Remove from the active list. Archived tasks live in a separate view.
      return null;

    case "attempt.started":
      if (!current) return null;
      return {
        ...current,
        current_attempt_id: event.payload.attempt_id,
        attempt_count: current.attempt_count + 1,
        status: "running",
        updated_at: event.ts,
      };

    case "phase.started":
      if (!current) return null;
      return {
        ...current,
        current_phase: event.payload.phase_name,
        updated_at: event.ts,
      };

    case "pushback.raised":
      if (!current) return null;
      return {
        ...current,
        pushback_count: current.pushback_count + 1,
        updated_at: event.ts,
      };

    case "pushback.resolved":
      if (!current) return null;
      return {
        ...current,
        pushback_count: Math.max(0, current.pushback_count - 1),
        updated_at: event.ts,
      };

    case "task.config_updated": {
      if (!current) return null;
      const phases = event.payload.config_diff.phases;
      if (!phases) return { ...current, updated_at: event.ts };
      return {
        ...current,
        phase_models: Object.fromEntries(
          phases.map((ph) => [ph.name, ph.model]),
        ),
        updated_at: event.ts,
      };
    }

    case "task.dependency.set": {
      if (!current) return null;
      const deps = event.payload.depends_on;
      return {
        ...current,
        depends_on: deps,
        blocked: deps.length > 0,
        updated_at: event.ts,
      };
    }

    case "task.unblocked":
      if (!current) return null;
      return {
        ...current,
        blocked: false,
        status: "queued",
        updated_at: event.ts,
      };

    case "task.auto_approved":
      if (!current) return null;
      return { ...current, status: "approved", updated_at: event.ts };

    case "task.merged":
      if (!current) return null;
      return { ...current, status: "merged", auto_merged: false, updated_at: event.ts };

    case "task.auto_merged":
      if (!current) return null;
      return { ...current, status: "merged", auto_merged: true, updated_at: event.ts };

    case "task.finalized":
      if (!current) return null;
      // Map finalization reason to a terminal status.
      return {
        ...current,
        status: event.payload.reason === "merged" ? "merged" : "archived",
        updated_at: event.ts,
      };

    default:
      return current;
  }
}

// ============================================================================
// Reducer: TaskDetailRow
// ============================================================================

/**
 * Reducer for the task_detail projection. Handles the full task lifecycle
 * including config updates, worktree tracking, and proposition management.
 *
 * Unlike task_list, archived tasks are KEPT in task_detail (for history).
 */
export function reduceTaskDetail(
  current: TaskDetailRow | null,
  event: AnyEvent,
): TaskDetailRow | null {
  switch (event.type) {
    case "task.drafted": {
      if (current) return current; // idempotent
      const p = event.payload;
      return {
        task_id: p.task_id,
        title: p.title,
        status: "draft" as TaskStatus,
        config: DEFAULT_TASK_CONFIG,
        proposition_ids: p.proposition_ids,
        preset_override_keys: [],
        last_event_id: event.id,
        updated_at: event.ts,
      };
    }

    case "task.created": {
      const p = event.payload;
      return {
        task_id: p.task_id,
        title: p.title,
        status: "queued",
        config: p.config_snapshot,
        preset_id: p.preset_id,
        preset_override_keys: [],
        proposition_ids: p.proposition_ids,
        last_event_id: event.id,
        updated_at: event.ts,
      };
    }

    case "task.title_changed":
      if (!current) return null;
      return {
        ...current,
        title: event.payload.title,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.propositions_added":
      if (!current) return null;
      return {
        ...current,
        proposition_ids: [
          ...current.proposition_ids,
          ...event.payload.proposition_ids,
        ],
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.propositions_removed":
      if (!current) return null;
      return {
        ...current,
        proposition_ids: current.proposition_ids.filter(
          (id) => !event.payload.proposition_ids.includes(id),
        ),
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.config_updated": {
      if (!current) return null;
      const diff = event.payload.config_diff;

      // Merge config diff into existing config
      const merged: TaskConfig = { ...current.config };
      if (diff.phases) merged.phases = diff.phases;
      if (diff.gates) merged.gates = diff.gates;
      if (diff.retry_policy)
        merged.retry_policy = { ...current.config.retry_policy, ...diff.retry_policy };
      if (diff.auto_merge_policy !== undefined)
        merged.auto_merge_policy = diff.auto_merge_policy;
      if (diff.shadow_mode !== undefined)
        merged.shadow_mode = diff.shadow_mode;

      // Derive which keys are overridden vs the preset
      const overrideKeys = deriveOverrideKeys(diff, current.preset_override_keys);

      return {
        ...current,
        config: merged,
        preset_override_keys: overrideKeys,
        last_event_id: event.id,
        updated_at: event.ts,
      };
    }

    case "task.status_changed":
      if (!current) return null;
      return {
        ...current,
        status: event.payload.to,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.deferred":
      if (!current) return null;
      return {
        ...current,
        status: "blocked",
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.archived":
      if (!current) return null;
      return {
        ...current,
        status: "archived",
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.worktree_created":
      if (!current) return null;
      return {
        ...current,
        worktree_path: event.payload.path,
        worktree_branch: event.payload.branch,
        base_sha: event.payload.base_sha,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.worktree_deleted":
      if (!current) return null;
      return {
        ...current,
        worktree_path: undefined,
        worktree_branch: undefined,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "attempt.started":
      if (!current) return null;
      return {
        ...current,
        current_attempt_id: event.payload.attempt_id,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "pushback.raised":
      if (!current) return null;
      return {
        ...current,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "pushback.resolved":
      if (!current) return null;
      return {
        ...current,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.auto_approved":
      if (!current) return null;
      return {
        ...current,
        status: "approved",
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.merged":
      if (!current) return null;
      return {
        ...current,
        status: "merged",
        merge_commit_sha: event.payload.merge_commit_sha,
        merged_into_branch: event.payload.into_branch,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.auto_merged":
      if (!current) return null;
      return {
        ...current,
        status: "merged",
        merge_commit_sha: event.payload.merge_commit_sha,
        merged_into_branch: event.payload.into_branch,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    case "task.finalized":
      if (!current) return null;
      return {
        ...current,
        status: event.payload.reason === "merged" ? "merged" : "archived",
        last_event_id: event.id,
        updated_at: event.ts,
      };

    // merge.conflicted and merge.gate_failed update the task detail to
    // reflect the failed merge attempt but don't change status (the task
    // remains in awaiting_review or approved).
    case "merge.conflicted":
    case "merge.gate_failed":
    case "task.would_auto_merge":
      if (!current) return null;
      return {
        ...current,
        last_event_id: event.id,
        updated_at: event.ts,
      };

    default:
      return current;
  }
}

/**
 * Derives the set of config keys that differ from the preset.
 * Each config_updated event carries a diff — the keys in that diff
 * are added to the override set (deduplicated).
 */
function deriveOverrideKeys(
  diff: Partial<TaskConfig>,
  existing: string[],
): string[] {
  const keys = new Set(existing);
  if (diff.phases) keys.add("phases");
  if (diff.gates) keys.add("gates");
  if (diff.retry_policy) {
    // Track individual retry_policy sub-keys
    for (const key of Object.keys(diff.retry_policy)) {
      keys.add(`retry_policy.${key}`);
    }
  }
  if (diff.auto_merge_policy !== undefined) keys.add("auto_merge_policy");
  if (diff.shadow_mode !== undefined) keys.add("shadow_mode");
  return [...keys];
}

// ============================================================================
// ProviderHealth reducer
// ============================================================================

/**
 * Folds provider.configured, provider.probed, provider.auth_changed into a
 * single ProviderHealthRow per provider_id. Returning null would delete the
 * row, but providers are never removed from the projection — once configured
 * they stay (with status downgraded if needed).
 */
export function reduceProviderHealth(
  current: ProviderHealthRow | null,
  event: AnyEvent,
): ProviderHealthRow | null {
  switch (event.type) {
    case "provider.configured":
      return {
        provider_id: event.payload.provider_id,
        transport: event.payload.transport,
        status: current?.status ?? "unknown",
        latency_ms: current?.latency_ms,
        last_probe_at: current?.last_probe_at,
        last_error: current?.last_error,
        models: event.payload.models_advertised ?? current?.models,
        binary_path: event.payload.binary_path,
        endpoint: event.payload.endpoint,
        auth_method: event.payload.auth_method,
        auth_present: current?.auth_present ?? false,
      };

    case "provider.probed": {
      if (!current) return null;
      // For API providers (env_var auth), infer auth_present from probe result:
      // a successful probe means the key was used and accepted.
      const authPresent = current.auth_method === "env_var"
        ? event.payload.status === "healthy"
        : current.auth_present;
      return {
        ...current,
        status: event.payload.status,
        latency_ms: event.payload.latency_ms,
        last_probe_at: event.ts,
        last_error: event.payload.error,
        models: event.payload.models_listed ?? current.models,
        auth_present: authPresent,
      };
    }

    case "provider.auth_changed":
      if (!current) return null;
      return {
        ...current,
        auth_method: event.payload.auth_method,
      };

    default:
      return current;
  }
}

// ============================================================================
// Preset reducer
// ============================================================================

/**
 * Folds preset.created, preset.updated, preset.deleted into a single
 * PresetRow per preset_id. Returning null removes the row.
 */
export function reducePreset(
  current: PresetRow | null,
  event: AnyEvent,
): PresetRow | null {
  switch (event.type) {
    case "preset.created":
      if (current) return current; // idempotent — first write wins
      return {
        preset_id: event.payload.preset_id,
        name: event.payload.name,
        task_class: event.payload.task_class,
        config: event.payload.config,
        updated_at: event.ts,
      };

    case "preset.updated": {
      if (!current) return null;
      return {
        ...current,
        config: { ...current.config, ...event.payload.config_diff },
        updated_at: event.ts,
      };
    }

    case "preset.deleted":
      return null;

    default:
      return current;
  }
}

// ============================================================================
// Reducer: PropositionRow
// ============================================================================

/**
 * Folds proposition lifecycle events into a PropositionRow.
 * Handles: extracted, edited, amended, merged, split, deleted,
 * and pushback raised/resolved to track active_pushback_ids.
 */
export function reduceProposition(
  current: PropositionRow | null,
  event: AnyEvent,
): PropositionRow | null {
  switch (event.type) {
    case "proposition.extracted": {
      const p = event.payload;
      return {
        proposition_id: p.proposition_id,
        prd_id: p.prd_id,
        text: p.text,
        source_span: p.source_span,
        confidence: p.confidence,
        active_pushback_ids: [],
        updated_at: event.ts,
      };
    }

    case "proposition.edited":
      if (!current) return null;
      return { ...current, text: event.payload.text, updated_at: event.ts };

    case "proposition.amended":
      if (!current) return null;
      return { ...current, text: event.payload.new_text, updated_at: event.ts };

    case "proposition.merged":
      // The merged proposition is absorbed into another; delete this row.
      return null;

    case "proposition.split":
      // The original is split into new propositions; delete original.
      return null;

    case "proposition.deleted":
      return null;

    case "pushback.raised": {
      if (!current) return null;
      const pushbackId = (event.payload as { pushback_id: string }).pushback_id;
      if (current.active_pushback_ids.includes(pushbackId)) return current;
      return {
        ...current,
        active_pushback_ids: [...current.active_pushback_ids, pushbackId],
        updated_at: event.ts,
      };
    }

    case "pushback.resolved": {
      if (!current) return null;
      const pushbackId = (event.payload as { pushback_id: string }).pushback_id;
      return {
        ...current,
        active_pushback_ids: current.active_pushback_ids.filter(
          (id) => id !== pushbackId,
        ),
        updated_at: event.ts,
      };
    }

    default:
      return current;
  }
}

// ============================================================================
// Subscription map: event type → projections it updates
// ============================================================================

/**
 * Used by the projection runner. On each event, look up which projections
 * subscribe, run each reducer, write the updated rows. Most events touch
 * 1–3 projections; invocation.completed touches the most because that's
 * when cost, prompt usage, and A/B stats all update together.
 */
export const PROJECTION_SUBSCRIPTIONS: Record<EventType, ProjectionName[]> = {
  // PRD
  "prd.ingested": [],

  // Proposition
  "proposition.extracted": ["proposition"],
  "proposition.edited": ["proposition"],
  "proposition.merged": ["proposition"],
  "proposition.split": ["proposition"],
  "proposition.amended": ["proposition"],
  "proposition.deleted": ["proposition"],

  // Task
  "task.drafted": ["task_list", "task_detail"],
  "task.created": ["task_list", "task_detail"],
  "task.title_changed": ["task_list", "task_detail"],
  "task.propositions_added": ["task_detail", "proposition"],
  "task.propositions_removed": ["task_detail", "proposition"],
  "task.config_updated": ["task_list", "task_detail"],
  "task.status_changed": ["task_list", "task_detail"],
  "task.deferred": ["task_list", "task_detail"],
  "task.archived": ["task_list", "task_detail"],
  "task.worktree_created": ["task_detail"],
  "task.worktree_deleted": ["task_detail"],
  "task.dependency.set": ["task_list"],
  "task.unblocked": ["task_list"],
  "task.dependency.warning": [],

  // Attempt
  "attempt.started": ["task_list", "task_detail", "attempt"],
  "attempt.paused": ["task_list", "attempt"],
  "attempt.resumed": ["task_list", "attempt"],
  "attempt.killed": ["task_list", "attempt"],
  "attempt.completed": ["task_list", "attempt"],
  "attempt.approved": ["task_list", "attempt"],
  "attempt.rejected": ["task_list", "attempt"],
  "attempt.retry_requested": ["task_list", "attempt"],
  "attempt.committed": ["attempt"],

  // Phase
  "phase.started": ["task_list", "attempt"],
  "phase.context_packed": ["attempt"],
  "phase.completed": ["attempt"],
  "phase.failed": ["attempt"],
  "phase.diff_snapshotted": ["attempt"],

  // Invocation
  "invocation.started": ["attempt"],
  "invocation.assistant_message": [],
  "invocation.tool_called": ["attempt"],
  "invocation.tool_returned": ["attempt"],
  "invocation.file_edited": ["attempt"],
  "invocation.completed": [
    "attempt",
    "prompt_library",
    "ab_experiment",
    "cost_rollup",
  ],
  "invocation.errored": ["attempt"],

  // Gate
  "gate.started": ["attempt"],
  "gate.passed": ["attempt"],
  "gate.failed": ["attempt"],
  "gate.timed_out": ["attempt"],
  "gate.skipped": ["attempt"],

  // Audit
  "auditor.judged": ["attempt", "prompt_library", "ab_experiment"],
  "audit.overridden": ["attempt"],

  // Pushback
  "pushback.raised": ["task_list", "task_detail", "proposition"],
  "pushback.resolved": ["task_list", "task_detail", "proposition"],

  // PromptVersion
  "prompt_version.created": ["prompt_library"],
  "prompt_version.retired": ["prompt_library"],
  "ab_experiment.created": ["ab_experiment"],
  "ab_experiment.concluded": ["ab_experiment"],

  // Gate Library
  "gate_library.gate_added": ["gate_library"],
  "gate_library.gate_updated": ["gate_library"],
  "gate_library.gate_removed": ["gate_library"],

  // Settings
  "settings.changed": ["settings"],

  // Preset
  "preset.created": ["preset"],
  "preset.updated": ["preset"],
  "preset.deleted": ["preset"],

  // Provider
  "provider.configured": ["provider_health"],
  "provider.probed": ["provider_health"],
  "provider.auth_changed": ["provider_health"],

  // FS
  "files.changed_externally": [],

  // Classifier
  "classifier.selected_strategy": [],

  // Merge
  "task.merged": ["task_list", "task_detail"],
  "merge.conflicted": ["task_list", "task_detail", "attempt"],
  "merge.gate_failed": ["task_list", "task_detail", "attempt"],
  "task.finalized": ["task_list", "task_detail"],

  // Auto-merge
  "task.auto_approved": ["task_list", "task_detail"],
  "task.auto_merged": ["task_list", "task_detail"],
  "task.would_auto_merge": [],

  // Settings — auto-merge kill switch
  "settings.auto_merge_enabled_set": ["settings"],
};

// ============================================================================
// Reducer: AttemptRow
// ============================================================================

/**
 * Folds all attempt-lifecycle events into an AttemptRow.
 *
 * Events are keyed to a row via one of:
 *   - aggregate_type === "attempt" → aggregate_id is the attempt_id
 *   - correlation_id === attempt_id (set by phaseRunner, gate runner, adapters)
 *
 * The read(db, event) function in the attempt projection extracts the id via
 * the helper pattern used by other projections.
 */
export function reduceAttempt(
  current: AttemptRow | null,
  event: AnyEvent,
): AttemptRow | null {
  switch (event.type) {
    // ------------------------------------------------------------------
    // Attempt lifecycle
    // ------------------------------------------------------------------
    case "attempt.started": {
      if (current) return current; // idempotent
      const p = event.payload;
      return {
        attempt_id: p.attempt_id,
        task_id: p.task_id,
        attempt_number: p.attempt_number,
        status: "running",
        started_at: event.ts,
        tokens_in_total: 0,
        tokens_out_total: 0,
        cost_usd_total: 0,
        phases: {},
        gate_runs: [],
        files_changed: [],
        config_snapshot: p.config_snapshot,
        previous_attempt_id: p.previous_attempt_id,
        last_failure_reason: null,
        last_event_id: event.id,
      };
    }

    case "attempt.paused":
      if (!current) return null;
      return { ...current, status: "paused", last_event_id: event.id };

    case "attempt.resumed":
      if (!current) return null;
      return { ...current, status: "running", last_event_id: event.id };

    case "attempt.killed":
      if (!current) return null;
      return { ...current, status: "killed", last_event_id: event.id };

    case "attempt.completed": {
      if (!current) return null;
      const p = event.payload;
      return {
        ...current,
        status: "completed",
        outcome: p.outcome,
        completed_at: event.ts,
        duration_ms: p.duration_ms,
        tokens_in_total: p.tokens_in_total,
        tokens_out_total: p.tokens_out_total,
        cost_usd_total: p.cost_usd_total,
        last_event_id: event.id,
      };
    }

    case "attempt.approved": {
      if (!current) return null;
      return {
        ...current,
        outcome: "approved",
        // Mark audit as overridden if it existed and override flag is set
        audit: current.audit
          ? {
              ...current.audit,
              overridden: (event.payload as { override?: boolean }).override === true,
            }
          : undefined,
        last_event_id: event.id,
      };
    }

    case "attempt.rejected":
      if (!current) return null;
      return { ...current, outcome: "rejected", last_event_id: event.id };

    case "attempt.retry_requested":
      if (!current) return null;
      return { ...current, outcome: "revised", last_event_id: event.id };

    case "attempt.committed":
      if (!current) return null;
      return {
        ...current,
        commit_sha: event.payload.commit_sha,
        empty: event.payload.empty,
        // Non-empty: point to self. Empty: leave undefined for write-time resolution.
        effective_diff_attempt_id: event.payload.empty ? undefined : current.attempt_id,
        last_event_id: event.id,
      };

    // ------------------------------------------------------------------
    // Phase lifecycle
    // ------------------------------------------------------------------
    case "phase.started": {
      if (!current) return null;
      const p = event.payload;
      return {
        ...current,
        phases: {
          ...current.phases,
          [p.phase_name]: {
            phase_name: p.phase_name,
            status: "running",
            model: p.model,
            prompt_version_id: p.prompt_version_id,
          },
        },
        last_event_id: event.id,
      };
    }

    case "phase.context_packed": {
      if (!current) return null;
      const p = event.payload;
      const existing = current.phases[p.phase_name];
      if (!existing) return { ...current, last_event_id: event.id };
      return {
        ...current,
        phases: {
          ...current.phases,
          [p.phase_name]: { ...existing, context_manifest_hash: p.manifest_hash },
        },
        last_event_id: event.id,
      };
    }

    case "phase.completed": {
      if (!current) return null;
      const p = event.payload;
      const existing = current.phases[p.phase_name];
      const exitReason = p.exit_reason;
      const lastFailureReason =
        exitReason && exitReason !== "normal" ? exitReason : current.last_failure_reason;
      return {
        ...current,
        last_failure_reason: lastFailureReason,
        phases: {
          ...current.phases,
          [p.phase_name]: {
            ...(existing ?? { phase_name: p.phase_name }),
            status: p.outcome === "success" ? "succeeded" : "failed",
            tokens_in: p.tokens_in,
            tokens_out: p.tokens_out,
            cost_usd: p.cost_usd,
            duration_ms: p.duration_ms,
            diff_hash: p.diff_hash,
          },
        },
        last_failure_reason:
          p.outcome !== "success" && p.exit_reason ? p.exit_reason : current.last_failure_reason,
        last_event_id: event.id,
      };
    }

    case "phase.diff_snapshotted": {
      if (!current) return null;
      const p = event.payload;
      const existing = current.phases[p.phase_name];
      if (!existing) return { ...current, last_event_id: event.id };
      return {
        ...current,
        phases: {
          ...current.phases,
          [p.phase_name]: { ...existing, diff_hash: p.diff_hash },
        },
        last_event_id: event.id,
      };
    }

    case "phase.failed": {
      if (!current) return null;
      const p = event.payload;
      const existing = current.phases[p.phase_name];
      return {
        ...current,
        phases: {
          ...current.phases,
          [p.phase_name]: {
            ...(existing ?? { phase_name: p.phase_name }),
            status: "failed",
          },
        },
        last_event_id: event.id,
      };
    }

    // ------------------------------------------------------------------
    // Invocation events (update token totals, file changes)
    // ------------------------------------------------------------------
    case "invocation.completed": {
      if (!current) return null;
      const p = event.payload;
      return {
        ...current,
        tokens_in_total: current.tokens_in_total + p.tokens_in,
        tokens_out_total: current.tokens_out_total + p.tokens_out,
        cost_usd_total: current.cost_usd_total + p.cost_usd,
        last_event_id: event.id,
      };
    }

    case "invocation.file_edited": {
      if (!current) return null;
      const p = event.payload;
      // Accumulate per-file stats (a path may be edited by multiple tool calls)
      const existing = current.files_changed.find((f) => f.path === p.path);
      const op: FileChangeSummary["operation"] =
        p.operation === "create" ? "create" : p.operation === "delete" ? "delete" : "update";
      const files_changed: FileChangeSummary[] = existing
        ? current.files_changed.map((f) =>
            f.path === p.path
              ? {
                  ...f,
                  lines_added: f.lines_added + p.lines_added,
                  lines_removed: f.lines_removed + p.lines_removed,
                }
              : f,
          )
        : [
            ...current.files_changed,
            { path: p.path, operation: op, lines_added: p.lines_added, lines_removed: p.lines_removed },
          ];
      return { ...current, files_changed, last_event_id: event.id };
    }

    // ------------------------------------------------------------------
    // Gate events (track runs)
    // ------------------------------------------------------------------
    case "gate.started": {
      if (!current) return null;
      const p = event.payload;
      if (current.gate_runs.some((g) => g.gate_run_id === p.gate_run_id)) {
        return { ...current, last_event_id: event.id };
      }
      return {
        ...current,
        gate_runs: [
          ...current.gate_runs,
          { gate_run_id: p.gate_run_id, gate_name: p.gate_name, status: "running" },
        ],
        last_event_id: event.id,
      };
    }

    case "gate.passed": {
      if (!current) return null;
      const p = event.payload;
      return {
        ...current,
        gate_runs: current.gate_runs.map((g) =>
          g.gate_run_id === p.gate_run_id
            ? { ...g, status: "passed" as const, duration_ms: p.duration_ms }
            : g,
        ),
        last_event_id: event.id,
      };
    }

    case "gate.failed": {
      if (!current) return null;
      const p = event.payload;
      return {
        ...current,
        gate_runs: current.gate_runs.map((g) =>
          g.gate_run_id === p.gate_run_id
            ? {
                ...g,
                status: "failed" as const,
                duration_ms: p.duration_ms,
                failure_count: p.failures.length,
              }
            : g,
        ),
        last_event_id: event.id,
      };
    }

    case "gate.timed_out": {
      if (!current) return null;
      const p = event.payload;
      return {
        ...current,
        gate_runs: current.gate_runs.map((g) =>
          g.gate_run_id === p.gate_run_id
            ? { ...g, status: "timed_out" as const }
            : g,
        ),
        last_event_id: event.id,
      };
    }

    // ------------------------------------------------------------------
    // Audit events
    // ------------------------------------------------------------------
    case "auditor.judged": {
      if (!current) return null;
      const p = event.payload;
      return {
        ...current,
        audit: {
          verdict: p.verdict,
          confidence: p.confidence,
          concern_count: p.concerns.length,
          blocking_count: p.concerns.filter((c: AuditConcern) => c.severity === "blocking").length,
          concerns: p.concerns,
          overridden: false,
        },
        last_event_id: event.id,
      };
    }

    case "audit.overridden": {
      if (!current || !current.audit) return current ?? null;
      return {
        ...current,
        audit: { ...current.audit, overridden: true },
        last_event_id: event.id,
      };
    }

    // invocation.started / invocation.tool_called / invocation.tool_returned
    // / invocation.errored / gate.skipped / attempt.retry_requested (already handled)
    // These update last_event_id but don't change tracked fields.
    case "invocation.started":
    case "invocation.assistant_message":
    case "invocation.tool_called":
    case "invocation.tool_returned":
    case "invocation.errored":
    case "gate.skipped":
      if (!current) return null;
      return { ...current, last_event_id: event.id };

    default:
      return current;
  }
}

// ============================================================================
// Projection runner — skeleton
// ============================================================================

/**
 * The runner hooks into event append. For every event written, it finds the
 * subscribed projections, fetches the current row(s), runs the reducer, and
 * writes back. All of this happens in the same SQLite transaction as the
 * event append, so a crash mid-update leaves everything consistent.
 *
 * Pseudocode:
 *
 *   function appendEvent(event: AnyEvent): void {
 *     db.transaction(() => {
 *       db.run("INSERT INTO events (...) VALUES (...)", event);
 *       for (const projectionName of PROJECTION_SUBSCRIPTIONS[event.type]) {
 *         const reducer = REDUCERS[projectionName];
 *         const current = reducer.read(db, event);        // fetches affected row(s)
 *         const next    = reducer.fold(current, event);   // pure function
 *         reducer.write(db, next);                        // upsert or delete
 *         db.run(
 *           "UPDATE projection_watermarks SET last_event_id = ? WHERE projection_name = ?",
 *           event.id, projectionName,
 *         );
 *       }
 *       emitSse(event); // fan out to UI clients AFTER commit
 *     });
 *   }
 *
 * SSE emission sits outside the transaction — we only notify clients once
 * the write has committed.
 */

// ============================================================================
// Reducer: PromptVersionRow
// ============================================================================

/**
 * Folds prompt_version.created, prompt_version.retired, invocation.completed
 * (usage stats), and ab_experiment events into a PromptVersionRow.
 *
 * Note: invocation.completed requires a cross-event DB lookup in the server
 * projection's read() function to resolve the prompt_version_id. On the client
 * this event is skipped for prompt_library (REST hydration covers it).
 */
export function reducePromptLibrary(
  current: PromptVersionRow | null,
  event: AnyEvent,
): PromptVersionRow | null {
  switch (event.type) {
    case "prompt_version.created":
      if (current) return current; // idempotent
      return {
        prompt_version_id: event.payload.prompt_version_id,
        name: event.payload.name,
        phase_class: event.payload.phase_class,
        template_hash: event.payload.template_hash,
        parent_version_id: event.payload.parent_version_id,
        notes: event.payload.notes,
        retired: false,
        invocations_last_30d: 0,
        success_rate_last_30d: undefined,
        avg_cost_usd: undefined,
        ab_experiment_ids: [],
        created_at: event.ts,
      };

    case "prompt_version.retired":
      if (!current) return null;
      return { ...current, retired: true };

    case "invocation.completed": {
      // current is resolved via cross-event lookup in read() on the server.
      // If null (client-side or lookup failed), treat as no-op.
      if (!current) return null;
      const oldCount = current.invocations_last_30d;
      const newCount = oldCount + 1;
      const isSuccess =
        (event.payload as { outcome: string }).outcome === "success";
      const oldRate = current.success_rate_last_30d ?? 0;
      const newRate =
        (oldRate * oldCount + (isSuccess ? 1 : 0)) / newCount;
      const cost = (event.payload as { cost_usd: number }).cost_usd ?? 0;
      const oldAvg = current.avg_cost_usd ?? 0;
      const newAvg = (oldAvg * oldCount + cost) / newCount;
      return {
        ...current,
        invocations_last_30d: newCount,
        success_rate_last_30d: newRate,
        avg_cost_usd: newAvg,
      };
    }

    case "ab_experiment.created": {
      if (!current) return current;
      const variants = event.payload.variants as { A: string; B: string };
      const isVariant =
        variants.A === current.prompt_version_id ||
        variants.B === current.prompt_version_id;
      if (!isVariant || current.ab_experiment_ids.includes(event.payload.experiment_id)) {
        return current;
      }
      return {
        ...current,
        ab_experiment_ids: [
          ...current.ab_experiment_ids,
          event.payload.experiment_id,
        ],
      };
    }

    case "ab_experiment.concluded":
      // Keep the link; the experiment moves to concluded status in ab_experiment projection.
      return current;

    default:
      return current;
  }
}

// ============================================================================
// Reducer: AbExperimentRow
// ============================================================================

/**
 * Folds ab_experiment.created and ab_experiment.concluded into an AbExperimentRow.
 * Invocation-level stats (n_a, n_b) are updated in Priority 34.
 */
export function reduceAbExperiment(
  current: AbExperimentRow | null,
  event: AnyEvent,
): AbExperimentRow | null {
  switch (event.type) {
    case "ab_experiment.created":
      if (current) return current; // idempotent
      return {
        experiment_id: event.payload.experiment_id,
        phase_class: event.payload.phase_class,
        variant_a_id: event.payload.variants.A,
        variant_b_id: event.payload.variants.B,
        bucket_key: event.payload.bucket_key,
        split_a: event.payload.split[0],
        a_n: 0,
        a_success_n: 0,
        a_cost_usd: 0,
        b_n: 0,
        b_success_n: 0,
        b_cost_usd: 0,
        a_success_rate: 0,
        b_success_rate: 0,
        significance_p: undefined,
        status: "running",
        winner: undefined,
      };

    case "ab_experiment.concluded": {
      if (!current) return null;
      const s = event.payload.stats;
      return {
        ...current,
        status: "concluded",
        winner: event.payload.winner,
        a_n: s.a.n,
        a_success_n: Math.round(s.a.n * s.a.success_rate),
        a_cost_usd: s.a.avg_cost_usd * s.a.n,
        b_n: s.b.n,
        b_success_n: Math.round(s.b.n * s.b.success_rate),
        b_cost_usd: s.b.avg_cost_usd * s.b.n,
        a_success_rate: s.a.success_rate,
        b_success_rate: s.b.success_rate,
      };
    }

    case "invocation.completed": {
      // _variant is set by the projection's read() via cross-event lookup.
      // If null or no _variant, this event doesn't belong to any running experiment.
      if (!current || !current._variant) return current;
      const variant = current._variant;
      if (variant === "A") {
        const a_n = current.a_n + 1;
        const a_cost_usd = current.a_cost_usd + event.payload.cost_usd;
        const a_success_rate = a_n > 0 ? current.a_success_n / a_n : 0;
        return { ...current, a_n, a_cost_usd, a_success_rate };
      } else {
        const b_n = current.b_n + 1;
        const b_cost_usd = current.b_cost_usd + event.payload.cost_usd;
        const b_success_rate = b_n > 0 ? current.b_success_n / b_n : 0;
        return { ...current, b_n, b_cost_usd, b_success_rate };
      }
    }

    case "auditor.judged": {
      // _variant is set by the projection's read() via prompt_version_id lookup.
      // Only "approve" verdicts count as successes.
      if (!current || !current._variant) return current;
      const variant = current._variant;
      if (event.payload.verdict !== "approve") return current;
      if (variant === "A") {
        const a_success_n = current.a_success_n + 1;
        const a_success_rate = current.a_n > 0 ? a_success_n / current.a_n : 0;
        return { ...current, a_success_n, a_success_rate };
      } else {
        const b_success_n = current.b_success_n + 1;
        const b_success_rate = current.b_n > 0 ? b_success_n / current.b_n : 0;
        return { ...current, b_success_n, b_success_rate };
      }
    }

    default:
      return current;
  }
}

// ============================================================================
// Reducer: CostRollupRow
// ============================================================================

/**
 * Folds invocation.completed events into per-day cost aggregates.
 *
 * NOTE: current must never be null when called for cost_rollup — the
 * projection's read() method always bootstraps a seed row (with zero counts
 * and the correct date/provider/model/phase_class) before reduce() is called.
 * If current is somehow null, we return null (a no-op in the runner).
 */
export function reduceCostRollup(
  current: CostRollupRow | null,
  event: AnyEvent,
): CostRollupRow | null {
  if (!current) return null;

  switch (event.type) {
    case "invocation.completed":
      return {
        ...current,
        invocation_count: current.invocation_count + 1,
        tokens_in: current.tokens_in + event.payload.tokens_in,
        tokens_out: current.tokens_out + event.payload.tokens_out,
        cost_usd: current.cost_usd + event.payload.cost_usd,
      };

    default:
      return current;
  }
}

// ============================================================================
// Reducer: GlobalSettingsRow
// ============================================================================

export function reduceSettings(
  current: GlobalSettingsRow | null,
  event: AnyEvent,
): GlobalSettingsRow | null {
  const defaults: GlobalSettingsRow = {
    settings_id: "global",
    default_preset_id: null,
    auto_delete_worktree_on_merge: false,
    auto_pause_on_external_fs_change: false,
    auto_merge_enabled: false,
    updated_at: event.ts,
  };

  switch (event.type) {
    case "settings.changed":
      return { ...(current ?? defaults), ...event.payload.changes, updated_at: event.ts };

    case "settings.auto_merge_enabled_set":
      return {
        ...(current ?? defaults),
        auto_merge_enabled: event.payload.enabled,
        updated_at: event.ts,
      };

    default:
      return current;
  }
}

// ============================================================================
// Reducer: GateLibraryRow
// ============================================================================

export function reduceGateLibrary(
  current: GateLibraryRow | null,
  event: AnyEvent,
): GateLibraryRow | null {
  switch (event.type) {
    case "gate_library.gate_added":
    case "gate_library.gate_updated":
      return {
        gate_name: event.payload.gate.name,
        command: event.payload.gate.command,
        required: event.payload.gate.required,
        timeout_seconds: event.payload.gate.timeout_seconds,
        on_fail: event.payload.gate.on_fail,
        updated_at: event.ts,
      };
    case "gate_library.gate_removed":
      return null;
    default:
      return current;
  }
}
