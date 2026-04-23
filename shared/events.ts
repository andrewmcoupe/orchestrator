/**
 * Orchestrator event schema — the canonical contract.
 *
 * Everything is event-sourced. The event log (append-only SQLite table) is
 * the source of truth. Every other piece of state — task list, task status,
 * current phase, provider health, prompt stats, cost totals, A/B results,
 * even the filesystem — is a projection derived from these events.
 *
 * Naming: {aggregate}.{past_tense_verb}. Past tense because events are facts
 * that have already happened. "task.created" not "create_task".
 *
 * Transport: CLI adapters and API adapters both emit these events via a
 * normalizer, so downstream consumers never know what produced them.
 *
 * UI: subscribes via SSE, folds events into local state with the same
 * reducer the server uses for projections. Client and server share this file.
 *
 * Invariants:
 *   - Events are immutable once written.
 *   - version is monotonic per aggregate_id (optimistic concurrency).
 *   - ids are ULIDs (sortable, collision-resistant, K-sorted).
 *   - correlation_id groups events so the UI can slice the stream.
 *   - causation_id forms a DAG of cause/effect for debugging.
 */

// ============================================================================
// Envelope
// ============================================================================

export interface EventEnvelope<T extends EventType = EventType> {
  /** ULID. Monotonic, sortable. Primary key in the event store. */
  id: string;

  type: T;

  aggregate_type: AggregateType;
  aggregate_id: string;

  /** Per-aggregate monotonic version. Writers use it for optimistic locking. */
  version: number;

  /** ISO 8601 with milliseconds. */
  ts: string;

  /** Who or what caused this event. */
  actor: Actor;

  /**
   * Groups related events. All events for one attempt share that attempt's
   * id as correlation_id. Lets the UI filter "events for this task" cheaply.
   */
  correlation_id?: string;

  /** Parent event id. Makes cause/effect traceable. */
  causation_id?: string;

  payload: EventMap[T];
}

export type Actor =
  | { kind: "user"; user_id: string }
  | {
      kind: "agent";
      phase: PhaseName;
      model: string;
      prompt_version_id: string;
    }
  | {
      kind: "system";
      component:
        | "probe"
        | "scheduler"
        | "watcher"
        | "classifier"
        | "gate_runner";
    }
  | { kind: "cli"; transport: Transport; invocation_id: string };

export type AggregateType =
  | "prd"
  | "proposition"
  | "task"
  | "attempt"
  | "gate"
  | "audit"
  | "prompt_version"
  | "preset"
  | "provider"
  | "pushback"
  | "ab_experiment"
  | "gate_library"
  | "settings"
  | "merge";

export type Transport =
  | "claude-code"
  | "codex"
  | "aider"
  | "gemini-cli"
  | "anthropic-api"
  | "openai-api";

export type PhaseName = "test-author" | "implementer" | "auditor" | string;

// ============================================================================
// Supporting types (referenced by multiple events)
// ============================================================================

export type TaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "paused"
  | "awaiting_review"
  | "revising"
  | "approved"
  | "awaiting_merge"
  | "merged"
  | "rejected"
  | "archived"
  | "blocked";

/**
 * How to merge the worktree branch into the target branch.
 *   squash   — collapses all commits into one, clearest history
 *   merge    — standard merge commit, preserves branch topology
 *   ff-only  — fast-forward only; refuses if the branch has diverged
 */
export type MergeStrategy = "squash" | "merge" | "ff-only";

/**
 * Per-task auto-merge policy. Evaluated after attempt.completed.
 *   off               — manual merge only (default)
 *   on_full_pass      — auto-merge when auditor approves AND all required gates pass
 *   on_auditor_approve — auto-merge on auditor approve (gates may fail if advisory)
 */
export type AutoMergePolicy = "off" | "on_full_pass" | "on_auditor_approve";

export interface TaskConfig {
  phases: PhaseConfig[];
  gates: GateConfig[];
  retry_policy: RetryPolicy;
  /** Per-task auto-merge policy. Defaults to 'off'. */
  auto_merge_policy?: AutoMergePolicy;
  /** When true, auto-merge evaluates but does not merge — emits advisory events only. */
  shadow_mode?: boolean;
}

export interface PhaseConfig {
  name: PhaseName;
  enabled: boolean;
  transport: Transport;
  model: string;
  prompt_version_id: string;
  ab_experiment_id?: string;
  transport_options: TransportOptions;
  context_policy: ContextPolicy;
  /** Gate names to skip after this phase completes. Useful for phases
   *  like test-author where certain gates (e.g. "test") are expected to fail. */
  skip_gates?: string[];
}

export type TransportOptions =
  | {
      kind: "cli";
      bare?: boolean;
      max_turns: number;
      max_budget_usd: number;
      permission_mode: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";
      allowed_tools?: string[];
      append_system_prompt_path?: string;
      schema?: object; // JSON Schema for structured output via --json-schema
    }
  | {
      kind: "api";
      max_tokens: number;
      schema?: object; // JSON Schema for structured output
    };

export interface ContextPolicy {
  /** How far out from the target symbol to traverse the graph. */
  symbol_graph_depth: number;
  include_tests: boolean;
  include_similar_patterns: boolean;
  token_budget: number;
}

export interface GateConfig {
  name: string;
  command: string;
  required: boolean;
  timeout_seconds: number;
  on_fail: "retry" | "retry_with_context" | "skip" | "fail_task";
}

export interface RetryPolicy {
  on_typecheck_fail: { strategy: RetryStrategy; max_attempts: number };
  on_test_fail: { strategy: RetryStrategy; max_attempts: number };
  on_audit_reject: RetryStrategy;
  on_spec_pushback: "pause_and_notify" | "auto_defer";
  max_total_attempts: number;
}

export type RetryStrategy =
  | "retry_same"
  | "retry_with_more_context"
  | "reroute_to_stronger_model"
  | "decompose_task"
  | "escalate_to_human";

export interface AuditConcern {
  category:
    | "correctness"
    | "completeness"
    | "style"
    | "performance"
    | "security"
    | "nit";
  severity: "blocking" | "advisory";
  anchor?: { path: string; line: number; col?: number };
  rationale: string;
  /** Links back to the spec that the concern references. */
  reference_proposition_id?: string;
}

export interface ContextManifest {
  symbols: Array<{ name: string; path: string; reason: string; depth: number }>;
  files: Array<{ path: string; bytes: number }>;
  token_budget: number;
  token_estimated: number;
}

// ============================================================================
// PRD events
// ============================================================================

export interface PrdIngested {
  prd_id: string;
  path: string | null;
  size_bytes: number;
  lines: number;
  extractor_model: string;
  extractor_prompt_version_id: string;
  content_hash: string;
  content: string;
}

// ============================================================================
// Proposition events
// ============================================================================

export interface PropositionExtracted {
  proposition_id: string;
  prd_id: string;
  text: string;
  source_span: { section: string; line_start: number; line_end: number };
  confidence: number;
}

export interface PropositionEdited {
  proposition_id: string;
  text: string;
  previous_text: string;
}

export interface PropositionMerged {
  proposition_ids: string[];
  merged_into: string;
  new_text: string;
}

export interface PropositionSplit {
  proposition_id: string;
  into: Array<{ proposition_id: string; text: string }>;
}

export interface PropositionAmended {
  proposition_id: string;
  new_text: string;
  rationale: string;
  /** If this resolves a pushback, link it. */
  resolves_pushback_id?: string;
}

export interface PropositionDeleted {
  proposition_id: string;
  reason: string;
}

// ============================================================================
// Task events
// ============================================================================

export interface TaskDrafted {
  task_id: string;
  title: string;
  proposition_ids: string[];
  /** The ingest agent's proposed grouping, before human review. */
  proposed_by: "agent" | "user";
}

export interface TaskCreated {
  task_id: string;
  title: string;
  proposition_ids: string[];
  config_snapshot: TaskConfig;
  preset_id?: string;
}

export interface TaskTitleChanged {
  task_id: string;
  title: string;
}

export interface TaskPropositionsAdded {
  task_id: string;
  proposition_ids: string[];
}

export interface TaskPropositionsRemoved {
  task_id: string;
  proposition_ids: string[];
}

export interface TaskConfigUpdated {
  task_id: string;
  /** Only changed fields. Full config can be rebuilt by folding events. */
  config_diff: Partial<TaskConfig>;
  reason?: string;
}

export interface TaskStatusChanged {
  task_id: string;
  from: TaskStatus;
  to: TaskStatus;
}

export interface TaskDeferred {
  task_id: string;
  reason: string;
}

export interface TaskArchived {
  task_id: string;
}

export interface TaskWorktreeCreated {
  task_id: string;
  path: string;
  branch: string;
  base_ref: string;
}

export interface TaskWorktreeDeleted {
  task_id: string;
  path: string;
}

export interface TaskDependencySet {
  task_id: string;
  depends_on: string[];
}

export interface TaskUnblocked {
  task_id: string;
}

// ============================================================================
// Attempt events
// ============================================================================

export interface AttemptStarted {
  attempt_id: string;
  task_id: string;
  attempt_number: number;
  config_snapshot: TaskConfig;
  triggered_by: "user_start" | "retry" | "scheduler";
  /** If this is a retry, link the prior attempt. */
  previous_attempt_id?: string;
  /** If this retry carries feedback, what it was. */
  retry_feedback?: AuditConcern[];
}

export interface AttemptPaused {
  attempt_id: string;
  reason: string;
}

export interface AttemptResumed {
  attempt_id: string;
}

export interface AttemptKilled {
  attempt_id: string;
  reason: string;
}

export interface AttemptCompleted {
  attempt_id: string;
  outcome: "approved" | "rejected" | "revised" | "escalated" | "failed" | "no_changes";
  tokens_in_total: number;
  tokens_out_total: number;
  cost_usd_total: number;
  duration_ms: number;
}

export interface AttemptApproved {
  attempt_id: string;
  rationale?: string;
  /** True if approved despite an auditor revise/reject verdict. */
  overrode_audit: boolean;
}

export interface AttemptRejected {
  attempt_id: string;
  rationale?: string;
}

export interface AttemptRetryRequested {
  attempt_id: string;
  with_feedback: boolean;
  new_attempt_id: string;
  strategy: RetryStrategy;
}

// ============================================================================
// Phase events (boundaries within an attempt)
// ============================================================================

export interface PhaseStarted {
  attempt_id: string;
  phase_name: PhaseName;
  transport: Transport;
  model: string;
  prompt_version_id: string;
  ab_variant?: "A" | "B";
}

export interface PhaseContextPacked {
  attempt_id: string;
  phase_name: PhaseName;
  symbol_count: number;
  tokens_estimated: number;
  manifest_hash: string;
  manifest: ContextManifest;
}

export interface PhaseCompleted {
  attempt_id: string;
  phase_name: PhaseName;
  outcome: "success" | "failed" | "aborted";
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
  /** SHA-256 hash of the unified diff captured at phase completion, stored in the blob store. */
  diff_hash?: string;
}

export interface PhaseFailed {
  attempt_id: string;
  phase_name: PhaseName;
  error: string;
  error_category:
    | "provider_error"
    | "timeout"
    | "budget_exceeded"
    | "turn_limit"
    | "invalid_output"
    | "aborted"
    | "unknown";
}

// ============================================================================
// Invocation events (a single model call within a phase)
// ============================================================================

export interface InvocationStarted {
  invocation_id: string;
  attempt_id: string;
  phase_name: PhaseName;
  transport: Transport;
  model: string;
  prompt_version_id: string;
  context_manifest_hash: string;
}

export interface InvocationAssistantMessage {
  invocation_id: string;
  text: string;
  tokens?: number;
}

export interface InvocationToolCalled {
  invocation_id: string;
  tool_call_id: string;
  tool_name: string;
  /** Hash of args, not args themselves — args may contain sensitive paths. */
  args_hash: string;
  /** Full args are stored in a separate blob store indexed by hash. */
}

export interface InvocationToolReturned {
  invocation_id: string;
  tool_call_id: string;
  success: boolean;
  duration_ms: number;
  error?: string;
}

export interface InvocationFileEdited {
  invocation_id: string;
  path: string;
  operation: "create" | "update" | "delete";
  patch_hash: string; // full patch in blob store
  lines_added: number;
  lines_removed: number;
}

export interface InvocationCompleted {
  invocation_id: string;
  outcome: "success" | "failed" | "aborted";
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
  turns: number;
  exit_code?: number;
}

export interface InvocationErrored {
  invocation_id: string;
  error: string;
  error_category: PhaseFailed["error_category"];
}

// ============================================================================
// Gate events
// ============================================================================

export interface GateStarted {
  gate_run_id: string;
  gate_name: string;
  attempt_id: string;
  phase_name?: PhaseName;
}

export interface GatePassed {
  gate_run_id: string;
  gate_name: string;
  duration_ms: number;
}

export interface GateFailed {
  gate_run_id: string;
  gate_name: string;
  duration_ms: number;
  failures: Array<{
    category: string;
    location?: { path: string; line: number; col?: number };
    excerpt: string;
  }>;
}

export interface GateTimedOut {
  gate_run_id: string;
  gate_name: string;
  elapsed_ms: number;
}

export interface GateSkipped {
  gate_run_id: string;
  gate_name: string;
  reason: "not_required" | "previous_failed" | "explicit_skip";
}

// ============================================================================
// Audit events
// ============================================================================

export interface AuditorJudged {
  audit_id: string;
  attempt_id: string;
  verdict: "approve" | "revise" | "reject";
  confidence: number;
  summary: string;
  concerns: AuditConcern[];
  model: string;
  prompt_version_id: string;
}

export interface AuditOverridden {
  audit_id: string;
  rationale: string;
  effective_verdict: "approve" | "reject";
}

// ============================================================================
// Pushback events (agent flagging spec ambiguity)
// ============================================================================

export interface PushbackRaised {
  pushback_id: string;
  proposition_id: string;
  kind: "blocking" | "advisory" | "question";
  rationale: string;
  suggested_resolutions: string[];
  raised_by: { phase: PhaseName; model: string };
}

export interface PushbackResolved {
  pushback_id: string;
  resolution: "amended" | "reply_inline" | "deferred" | "dismissed";
  resolution_text?: string;
  amended_proposition_text?: string;
}

// ============================================================================
// PromptVersion events (the prompt library is event-sourced too)
// ============================================================================

export interface PromptVersionCreated {
  prompt_version_id: string;
  name: string;
  phase_class: PhaseName;
  template: string;
  template_hash: string;
  parent_version_id?: string;
  notes?: string;
}

export interface PromptVersionRetired {
  prompt_version_id: string;
  reason?: string;
}

export interface AbExperimentCreated {
  experiment_id: string;
  phase_class: PhaseName;
  variants: { A: string; B: string }; // prompt_version_ids
  split: [number, number]; // weights, e.g. [50, 50]
  /** Deterministic bucketing key, usually 'task_id+phase'. */
  bucket_key: string;
}

export interface AbExperimentConcluded {
  experiment_id: string;
  winner?: "A" | "B" | "none";
  reason: string;
  stats: {
    a: { n: number; success_rate: number; avg_cost_usd: number };
    b: { n: number; success_rate: number; avg_cost_usd: number };
  };
}

// ============================================================================
// Gate Library events (shared gate definitions, managed via Settings)
// ============================================================================

export interface GateLibraryGateAdded {
  gate: GateConfig;
}

export interface GateLibraryGateUpdated {
  gate_name: string;
  gate: GateConfig;
}

export interface GateLibraryGateRemoved {
  gate_name: string;
}

// ============================================================================
// Settings events (global defaults)
// ============================================================================

export interface GlobalSettings {
  default_preset_id: string | null;
  auto_delete_worktree_on_merge: boolean;
  auto_pause_on_external_fs_change: boolean;
  auto_merge_enabled: boolean;
}

export interface SettingsChanged {
  settings_id: "global";
  changes: Partial<GlobalSettings>;
}

// ============================================================================
// Preset events
// ============================================================================

export interface PresetCreated {
  preset_id: string;
  name: string;
  task_class: string;
  config: TaskConfig;
}

export interface PresetUpdated {
  preset_id: string;
  config_diff: Partial<TaskConfig>;
}

export interface PresetDeleted {
  preset_id: string;
}

// ============================================================================
// Provider events
// ============================================================================

export interface ProviderConfigured {
  provider_id: string;
  transport: Transport;
  binary_path?: string; // for CLI transports
  endpoint?: string; // for API transports
  auth_method: "env_var" | "keychain" | "cli_login";
  models_advertised?: string[];
}

export interface ProviderProbed {
  provider_id: string;
  status: "healthy" | "degraded" | "down";
  latency_ms?: number;
  error?: string;
  models_listed?: string[];
}

export interface ProviderAuthChanged {
  provider_id: string;
  auth_method: "env_var" | "keychain" | "cli_login";
}

// ============================================================================
// Filesystem events (out-of-band changes from the user)
// ============================================================================

export interface FilesChangedExternally {
  paths: string[];
  /** If the change is inside a task worktree, link it. */
  task_id?: string;
}

// ============================================================================
// Classifier events (only emitted if LLM-driven strategy selection is enabled)
// ============================================================================

export interface ClassifierSelectedStrategy {
  attempt_id: string;
  strategy: RetryStrategy;
  reasoning: string;
  inputs_hash: string;
}

// ============================================================================
// Merge events
// ============================================================================

/**
 * Emitted when a task's worktree branch has been successfully merged into the
 * target branch. This is the terminal success event for the merge workflow.
 */
export interface TaskMerged {
  task_id: string;
  attempt_id: string;
  merge_commit_sha: string;
  into_branch: string;
  /** The merge strategy used (from config or request override). */
  strategy: MergeStrategy;
  /** How many commits from the worktree branch landed on the target. */
  advanced_by_commits: number;
}

/**
 * Emitted when the merge attempt hits a git conflict. The main working tree
 * is left clean (git merge --abort was called). The worktree is intact so
 * the user can resolve conflicts manually.
 */
export interface MergeConflicted {
  task_id: string;
  attempt_id: string;
  conflicting_paths: string[];
  attempted_into_branch: string;
}

/**
 * Emitted when a required gate fails during the pre-merge gate run.
 * No merge was attempted. Task status reverts to awaiting_review.
 */
export interface MergeGateFailed {
  task_id: string;
  attempt_id: string;
  gate_name: string;
  failures: Array<{
    category: string;
    location?: { path: string; line: number; col?: number };
    excerpt: string;
  }>;
}

/**
 * Emitted when a task reaches its final state by any means other than
 * auto-merge (manual merge outside the tool, or explicit archival after
 * a completed attempt).
 */
export interface TaskFinalized {
  task_id: string;
  reason: "merged" | "manual" | "archived";
}

// ============================================================================
// Auto-merge events
// ============================================================================

/**
 * Emitted when the auto-merge evaluator determines a task should be
 * auto-approved (actor is system, not user).
 */
export interface TaskAutoApproved {
  task_id: string;
  attempt_id: string;
  policy: AutoMergePolicy;
  matched_conditions: string[];
}

/**
 * Emitted after a successful auto-merge (system-initiated merge).
 */
export interface TaskAutoMerged {
  task_id: string;
  attempt_id: string;
  merge_commit_sha: string;
  into_branch: string;
  policy: AutoMergePolicy;
  strategy: MergeStrategy;
}

/**
 * Shadow-mode advisory event — the auto-merge evaluator determined conditions
 * were met but shadow_mode prevented actual merge. Lets users observe what
 * _would_ have happened before enabling live auto-merge.
 */
export interface TaskWouldAutoMerge {
  task_id: string;
  attempt_id: string;
  policy: AutoMergePolicy;
  matched_conditions: string[];
}

// ============================================================================
// Settings — auto-merge kill switch
// ============================================================================

/**
 * Global kill switch for auto-merge. When enabled=false, auto-merge is
 * blocked regardless of per-task policy. Defaults to false (off).
 */
export interface SettingsAutoMergeEnabledSet {
  enabled: boolean;
}

// ============================================================================
// Event type registry — keyed map from event type to its payload
// ============================================================================

export interface EventMap {
  // PRD
  "prd.ingested": PrdIngested;

  // Proposition
  "proposition.extracted": PropositionExtracted;
  "proposition.edited": PropositionEdited;
  "proposition.merged": PropositionMerged;
  "proposition.split": PropositionSplit;
  "proposition.amended": PropositionAmended;
  "proposition.deleted": PropositionDeleted;

  // Task
  "task.drafted": TaskDrafted;
  "task.created": TaskCreated;
  "task.title_changed": TaskTitleChanged;
  "task.propositions_added": TaskPropositionsAdded;
  "task.propositions_removed": TaskPropositionsRemoved;
  "task.config_updated": TaskConfigUpdated;
  "task.status_changed": TaskStatusChanged;
  "task.deferred": TaskDeferred;
  "task.archived": TaskArchived;
  "task.worktree_created": TaskWorktreeCreated;
  "task.worktree_deleted": TaskWorktreeDeleted;
  "task.dependency.set": TaskDependencySet;
  "task.unblocked": TaskUnblocked;

  // Attempt
  "attempt.started": AttemptStarted;
  "attempt.paused": AttemptPaused;
  "attempt.resumed": AttemptResumed;
  "attempt.killed": AttemptKilled;
  "attempt.completed": AttemptCompleted;
  "attempt.approved": AttemptApproved;
  "attempt.rejected": AttemptRejected;
  "attempt.retry_requested": AttemptRetryRequested;

  // Phase
  "phase.started": PhaseStarted;
  "phase.context_packed": PhaseContextPacked;
  "phase.completed": PhaseCompleted;
  "phase.failed": PhaseFailed;

  // Invocation
  "invocation.started": InvocationStarted;
  "invocation.assistant_message": InvocationAssistantMessage;
  "invocation.tool_called": InvocationToolCalled;
  "invocation.tool_returned": InvocationToolReturned;
  "invocation.file_edited": InvocationFileEdited;
  "invocation.completed": InvocationCompleted;
  "invocation.errored": InvocationErrored;

  // Gate
  "gate.started": GateStarted;
  "gate.passed": GatePassed;
  "gate.failed": GateFailed;
  "gate.timed_out": GateTimedOut;
  "gate.skipped": GateSkipped;

  // Audit
  "auditor.judged": AuditorJudged;
  "audit.overridden": AuditOverridden;

  // Pushback
  "pushback.raised": PushbackRaised;
  "pushback.resolved": PushbackResolved;

  // PromptVersion
  "prompt_version.created": PromptVersionCreated;
  "prompt_version.retired": PromptVersionRetired;
  "ab_experiment.created": AbExperimentCreated;
  "ab_experiment.concluded": AbExperimentConcluded;

  // Gate Library
  "gate_library.gate_added": GateLibraryGateAdded;
  "gate_library.gate_updated": GateLibraryGateUpdated;
  "gate_library.gate_removed": GateLibraryGateRemoved;

  // Settings
  "settings.changed": SettingsChanged;

  // Preset
  "preset.created": PresetCreated;
  "preset.updated": PresetUpdated;
  "preset.deleted": PresetDeleted;

  // Provider
  "provider.configured": ProviderConfigured;
  "provider.probed": ProviderProbed;
  "provider.auth_changed": ProviderAuthChanged;

  // FS
  "files.changed_externally": FilesChangedExternally;

  // Classifier
  "classifier.selected_strategy": ClassifierSelectedStrategy;

  // Merge
  "task.merged": TaskMerged;
  "merge.conflicted": MergeConflicted;
  "merge.gate_failed": MergeGateFailed;
  "task.finalized": TaskFinalized;

  // Auto-merge
  "task.auto_approved": TaskAutoApproved;
  "task.auto_merged": TaskAutoMerged;
  "task.would_auto_merge": TaskWouldAutoMerge;

  // Settings — auto-merge kill switch
  "settings.auto_merge_enabled_set": SettingsAutoMergeEnabledSet;
}

export type EventType = keyof EventMap;
export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];
