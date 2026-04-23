/**
 * Zod schemas for every event payload in the EventMap.
 * Used by the event store to validate payloads before writing.
 */

import { z } from "zod";
import type { EventType } from "./events.js";

// ============================================================================
// Reusable schema fragments
// ============================================================================

const sourceSpanSchema = z.object({
  section: z.string(),
  line_start: z.number(),
  line_end: z.number(),
});

const transportSchema = z.enum([
  "claude-code",
  "codex",
  "aider",
  "gemini-cli",
  "anthropic-api",
  "openai-api",
]);

const taskStatusSchema = z.enum([
  "draft",
  "queued",
  "running",
  "paused",
  "awaiting_review",
  "revising",
  "approved",
  "awaiting_merge",
  "merged",
  "rejected",
  "archived",
  "blocked",
]);

const mergeStrategySchema = z.enum(["squash", "merge", "ff-only"]);

const autoMergePolicySchema = z.enum(["off", "on_full_pass", "on_auditor_approve"]);

const retryStrategySchema = z.enum([
  "retry_same",
  "retry_with_more_context",
  "reroute_to_stronger_model",
  "decompose_task",
  "escalate_to_human",
]);

const auditConcernSchema = z.object({
  category: z.enum([
    "correctness",
    "completeness",
    "style",
    "performance",
    "security",
    "nit",
  ]),
  severity: z.enum(["blocking", "advisory"]),
  anchor: z
    .object({
      path: z.string(),
      line: z.number(),
      col: z.number().optional(),
    })
    .optional(),
  rationale: z.string(),
  reference_proposition_id: z.string().optional(),
});

const contextPolicySchema = z.object({
  symbol_graph_depth: z.number(),
  include_tests: z.boolean(),
  include_similar_patterns: z.boolean(),
  token_budget: z.number(),
});

const transportOptionsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cli"),
    bare: z.boolean().optional(),
    max_turns: z.number(),
    max_budget_usd: z.number(),
    permission_mode: z.enum(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"]),
    allowed_tools: z.array(z.string()).optional(),
    append_system_prompt_path: z.string().optional(),
  }),
  z.object({
    kind: z.literal("api"),
    max_tokens: z.number(),
    schema: z.record(z.unknown()).optional(),
  }),
]);

const gateConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  required: z.boolean(),
  timeout_seconds: z.number(),
  on_fail: z.enum(["retry", "retry_with_context", "skip", "fail_task"]),
});

const retryPolicySchema = z.object({
  on_typecheck_fail: z.object({
    strategy: retryStrategySchema,
    max_attempts: z.number(),
  }),
  on_test_fail: z.object({
    strategy: retryStrategySchema,
    max_attempts: z.number(),
  }),
  on_audit_reject: retryStrategySchema,
  on_spec_pushback: z.enum(["pause_and_notify", "auto_defer"]),
  max_total_attempts: z.number(),
});

const phaseConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  transport: transportSchema,
  model: z.string(),
  prompt_version_id: z.string(),
  ab_experiment_id: z.string().optional(),
  transport_options: transportOptionsSchema,
  context_policy: contextPolicySchema,
});

const taskConfigSchema = z.object({
  phases: z.array(phaseConfigSchema),
  gates: z.array(gateConfigSchema),
  retry_policy: retryPolicySchema,
  auto_merge_policy: autoMergePolicySchema.optional(),
  shadow_mode: z.boolean().optional(),
});

const contextManifestSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      reason: z.string(),
      depth: z.number(),
    }),
  ),
  files: z.array(z.object({ path: z.string(), bytes: z.number() })),
  token_budget: z.number(),
  token_estimated: z.number(),
});

const errorCategorySchema = z.enum([
  "provider_error",
  "timeout",
  "budget_exceeded",
  "turn_limit",
  "invalid_output",
  "aborted",
  "unknown",
]);

// ============================================================================
// Per-event payload schemas
// ============================================================================

const prdIngestedSchema = z.object({
  prd_id: z.string(),
  path: z.string().nullable(),
  size_bytes: z.number(),
  lines: z.number(),
  extractor_model: z.string(),
  extractor_prompt_version_id: z.string(),
  content_hash: z.string(),
  content: z.string(),
});

const propositionExtractedSchema = z.object({
  proposition_id: z.string(),
  prd_id: z.string(),
  text: z.string(),
  source_span: sourceSpanSchema,
  confidence: z.number(),
});

const propositionEditedSchema = z.object({
  proposition_id: z.string(),
  text: z.string(),
  previous_text: z.string(),
});

const propositionMergedSchema = z.object({
  proposition_ids: z.array(z.string()),
  merged_into: z.string(),
  new_text: z.string(),
});

const propositionSplitSchema = z.object({
  proposition_id: z.string(),
  into: z.array(z.object({ proposition_id: z.string(), text: z.string() })),
});

const propositionAmendedSchema = z.object({
  proposition_id: z.string(),
  new_text: z.string(),
  rationale: z.string(),
  resolves_pushback_id: z.string().optional(),
});

const propositionDeletedSchema = z.object({
  proposition_id: z.string(),
  reason: z.string(),
});

const taskDraftedSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  proposition_ids: z.array(z.string()),
  proposed_by: z.enum(["agent", "user"]),
});

const taskCreatedSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  proposition_ids: z.array(z.string()),
  config_snapshot: taskConfigSchema,
  preset_id: z.string().optional(),
});

const taskTitleChangedSchema = z.object({
  task_id: z.string(),
  title: z.string(),
});

const taskPropositionsAddedSchema = z.object({
  task_id: z.string(),
  proposition_ids: z.array(z.string()),
});

const taskPropositionsRemovedSchema = z.object({
  task_id: z.string(),
  proposition_ids: z.array(z.string()),
});

const taskConfigUpdatedSchema = z.object({
  task_id: z.string(),
  config_diff: taskConfigSchema.partial(),
  reason: z.string().optional(),
});

const taskStatusChangedSchema = z.object({
  task_id: z.string(),
  from: taskStatusSchema,
  to: taskStatusSchema,
});

const taskDeferredSchema = z.object({
  task_id: z.string(),
  reason: z.string(),
});

const taskArchivedSchema = z.object({
  task_id: z.string(),
});

const taskWorktreeCreatedSchema = z.object({
  task_id: z.string(),
  path: z.string(),
  branch: z.string(),
  base_ref: z.string(),
});

const taskWorktreeDeletedSchema = z.object({
  task_id: z.string(),
  path: z.string(),
});

const taskDependencySetSchema = z.object({
  task_id: z.string(),
  depends_on: z.array(z.string()),
});

const taskUnblockedSchema = z.object({
  task_id: z.string(),
});

const taskDependencyWarningSchema = z.object({
  task_id: z.string(),
  dependency_id: z.string(),
  dependency_status: z.string(),
  message: z.string(),
});

const attemptStartedSchema = z.object({
  attempt_id: z.string(),
  task_id: z.string(),
  attempt_number: z.number(),
  config_snapshot: taskConfigSchema,
  triggered_by: z.enum(["user_start", "retry", "scheduler"]),
  previous_attempt_id: z.string().optional(),
  retry_feedback: z.array(auditConcernSchema).optional(),
});

const attemptPausedSchema = z.object({
  attempt_id: z.string(),
  reason: z.string(),
});

const attemptResumedSchema = z.object({
  attempt_id: z.string(),
});

const attemptKilledSchema = z.object({
  attempt_id: z.string(),
  reason: z.string(),
});

const attemptCompletedSchema = z.object({
  attempt_id: z.string(),
  outcome: z.enum([
    "approved",
    "rejected",
    "revised",
    "escalated",
    "failed",
    "no_changes",
  ]),
  tokens_in_total: z.number(),
  tokens_out_total: z.number(),
  cost_usd_total: z.number(),
  duration_ms: z.number(),
});

const attemptApprovedSchema = z.object({
  attempt_id: z.string(),
  rationale: z.string().optional(),
  overrode_audit: z.boolean(),
});

const attemptRejectedSchema = z.object({
  attempt_id: z.string(),
  rationale: z.string().optional(),
});

const attemptRetryRequestedSchema = z.object({
  attempt_id: z.string(),
  with_feedback: z.boolean(),
  new_attempt_id: z.string(),
  strategy: retryStrategySchema,
});

const phaseStartedSchema = z.object({
  attempt_id: z.string(),
  phase_name: z.string(),
  transport: transportSchema,
  model: z.string(),
  prompt_version_id: z.string(),
  ab_variant: z.enum(["A", "B"]).optional(),
});

const phaseContextPackedSchema = z.object({
  attempt_id: z.string(),
  phase_name: z.string(),
  symbol_count: z.number(),
  tokens_estimated: z.number(),
  manifest_hash: z.string(),
  manifest: contextManifestSchema,
});

const phaseCompletedSchema = z.object({
  attempt_id: z.string(),
  phase_name: z.string(),
  outcome: z.enum(["success", "failed", "aborted"]),
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost_usd: z.number(),
  duration_ms: z.number(),
  diff_hash: z.string().optional(),
});

const phaseFailedSchema = z.object({
  attempt_id: z.string(),
  phase_name: z.string(),
  error: z.string(),
  error_category: errorCategorySchema,
});

const invocationStartedSchema = z.object({
  invocation_id: z.string(),
  attempt_id: z.string(),
  phase_name: z.string(),
  transport: transportSchema,
  model: z.string(),
  prompt_version_id: z.string(),
  context_manifest_hash: z.string(),
});

const invocationAssistantMessageSchema = z.object({
  invocation_id: z.string(),
  text: z.string(),
  tokens: z.number().optional(),
});

const invocationToolCalledSchema = z.object({
  invocation_id: z.string(),
  tool_call_id: z.string(),
  tool_name: z.string(),
  args_hash: z.string(),
});

const invocationToolReturnedSchema = z.object({
  invocation_id: z.string(),
  tool_call_id: z.string(),
  success: z.boolean(),
  duration_ms: z.number(),
  error: z.string().optional(),
});

const invocationFileEditedSchema = z.object({
  invocation_id: z.string(),
  path: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  patch_hash: z.string(),
  lines_added: z.number(),
  lines_removed: z.number(),
});

const invocationCompletedSchema = z.object({
  invocation_id: z.string(),
  outcome: z.enum(["success", "failed", "aborted"]),
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost_usd: z.number(),
  duration_ms: z.number(),
  turns: z.number(),
  exit_code: z.number().optional(),
});

const invocationErroredSchema = z.object({
  invocation_id: z.string(),
  error: z.string(),
  error_category: errorCategorySchema,
});

const gateStartedSchema = z.object({
  gate_run_id: z.string(),
  gate_name: z.string(),
  attempt_id: z.string(),
  phase_name: z.string().optional(),
});

const gatePassedSchema = z.object({
  gate_run_id: z.string(),
  gate_name: z.string(),
  duration_ms: z.number(),
});

const gateFailedSchema = z.object({
  gate_run_id: z.string(),
  gate_name: z.string(),
  duration_ms: z.number(),
  failures: z.array(
    z.object({
      category: z.string(),
      location: z
        .object({
          path: z.string(),
          line: z.number(),
          col: z.number().optional(),
        })
        .optional(),
      excerpt: z.string(),
    }),
  ),
});

const gateTimedOutSchema = z.object({
  gate_run_id: z.string(),
  gate_name: z.string(),
  elapsed_ms: z.number(),
});

const gateSkippedSchema = z.object({
  gate_run_id: z.string(),
  gate_name: z.string(),
  reason: z.enum(["not_required", "previous_failed", "explicit_skip"]),
});

const auditorJudgedSchema = z.object({
  audit_id: z.string(),
  attempt_id: z.string(),
  verdict: z.enum(["approve", "revise", "reject"]),
  confidence: z.number(),
  summary: z.string(),
  concerns: z.array(auditConcernSchema),
  model: z.string(),
  prompt_version_id: z.string(),
});

const auditOverriddenSchema = z.object({
  audit_id: z.string(),
  rationale: z.string(),
  effective_verdict: z.enum(["approve", "reject"]),
});

const pushbackRaisedSchema = z.object({
  pushback_id: z.string(),
  proposition_id: z.string(),
  kind: z.enum(["blocking", "advisory", "question"]),
  rationale: z.string(),
  suggested_resolutions: z.array(z.string()),
  raised_by: z.object({ phase: z.string(), model: z.string() }),
});

const pushbackResolvedSchema = z.object({
  pushback_id: z.string(),
  resolution: z.enum(["amended", "reply_inline", "deferred", "dismissed"]),
  resolution_text: z.string().optional(),
  amended_proposition_text: z.string().optional(),
});

const promptVersionCreatedSchema = z.object({
  prompt_version_id: z.string(),
  name: z.string(),
  phase_class: z.string(),
  template: z.string(),
  template_hash: z.string(),
  parent_version_id: z.string().optional(),
  notes: z.string().optional(),
});

const promptVersionRetiredSchema = z.object({
  prompt_version_id: z.string(),
  reason: z.string().optional(),
});

const abExperimentCreatedSchema = z.object({
  experiment_id: z.string(),
  phase_class: z.string(),
  variants: z.object({ A: z.string(), B: z.string() }),
  split: z.tuple([z.number(), z.number()]),
  bucket_key: z.string(),
});

const abExperimentConcludedSchema = z.object({
  experiment_id: z.string(),
  winner: z.enum(["A", "B", "none"]).optional(),
  reason: z.string(),
  stats: z.object({
    a: z.object({
      n: z.number(),
      success_rate: z.number(),
      avg_cost_usd: z.number(),
    }),
    b: z.object({
      n: z.number(),
      success_rate: z.number(),
      avg_cost_usd: z.number(),
    }),
  }),
});

const gateLibraryGateAddedSchema = z.object({ gate: gateConfigSchema });
const gateLibraryGateUpdatedSchema = z.object({
  gate_name: z.string(),
  gate: gateConfigSchema,
});
const gateLibraryGateRemovedSchema = z.object({ gate_name: z.string() });
const globalSettingsChangesSchema = z.object({
  default_preset_id: z.string().nullable().optional(),
  auto_delete_worktree_on_merge: z.boolean().optional(),
  auto_pause_on_external_fs_change: z.boolean().optional(),
  auto_merge_enabled: z.boolean().optional(),
});
const settingsChangedSchema = z.object({
  settings_id: z.literal("global"),
  changes: globalSettingsChangesSchema,
});

const presetCreatedSchema = z.object({
  preset_id: z.string(),
  name: z.string(),
  task_class: z.string(),
  config: taskConfigSchema,
});

const presetUpdatedSchema = z.object({
  preset_id: z.string(),
  config_diff: taskConfigSchema.partial(),
});

const presetDeletedSchema = z.object({
  preset_id: z.string(),
});

const providerConfiguredSchema = z.object({
  provider_id: z.string(),
  transport: transportSchema,
  binary_path: z.string().optional(),
  endpoint: z.string().optional(),
  auth_method: z.enum(["env_var", "keychain", "cli_login"]),
  models_advertised: z.array(z.string()).optional(),
});

const providerProbedSchema = z.object({
  provider_id: z.string(),
  status: z.enum(["healthy", "degraded", "down"]),
  latency_ms: z.number().optional(),
  error: z.string().optional(),
  models_listed: z.array(z.string()).optional(),
});

const providerAuthChangedSchema = z.object({
  provider_id: z.string(),
  auth_method: z.enum(["env_var", "keychain", "cli_login"]),
});

const filesChangedExternallySchema = z.object({
  paths: z.array(z.string()),
  task_id: z.string().optional(),
});

const classifierSelectedStrategySchema = z.object({
  attempt_id: z.string(),
  strategy: retryStrategySchema,
  reasoning: z.string(),
  inputs_hash: z.string(),
});

// ============================================================================
// Merge event schemas
// ============================================================================

const taskMergedSchema = z.object({
  task_id: z.string(),
  attempt_id: z.string(),
  merge_commit_sha: z.string(),
  into_branch: z.string(),
  strategy: mergeStrategySchema,
  advanced_by_commits: z.number().int().nonnegative(),
});

const mergeConflictedSchema = z.object({
  task_id: z.string(),
  attempt_id: z.string(),
  conflicting_paths: z.array(z.string()),
  attempted_into_branch: z.string(),
});

const gateFailureSchema = z.object({
  category: z.string(),
  location: z
    .object({
      path: z.string(),
      line: z.number(),
      col: z.number().optional(),
    })
    .optional(),
  excerpt: z.string(),
});

const mergeGateFailedSchema = z.object({
  task_id: z.string(),
  attempt_id: z.string(),
  gate_name: z.string(),
  failures: z.array(gateFailureSchema),
});

const taskFinalizedSchema = z.object({
  task_id: z.string(),
  reason: z.enum(["merged", "manual", "archived"]),
});

// ============================================================================
// Auto-merge event schemas
// ============================================================================

const taskAutoApprovedSchema = z.object({
  task_id: z.string(),
  attempt_id: z.string(),
  policy: autoMergePolicySchema,
  matched_conditions: z.array(z.string()),
});

const taskAutoMergedSchema = z.object({
  task_id: z.string(),
  attempt_id: z.string(),
  merge_commit_sha: z.string(),
  into_branch: z.string(),
  policy: autoMergePolicySchema,
  strategy: mergeStrategySchema,
});

const taskWouldAutoMergeSchema = z.object({
  task_id: z.string(),
  attempt_id: z.string(),
  policy: autoMergePolicySchema,
  matched_conditions: z.array(z.string()),
});

const settingsAutoMergeEnabledSetSchema = z.object({
  enabled: z.boolean(),
});

// ============================================================================
// Schema registry keyed by EventType
// ============================================================================

export const eventPayloadSchemas: Record<EventType, z.ZodTypeAny> = {
  "prd.ingested": prdIngestedSchema,
  "proposition.extracted": propositionExtractedSchema,
  "proposition.edited": propositionEditedSchema,
  "proposition.merged": propositionMergedSchema,
  "proposition.split": propositionSplitSchema,
  "proposition.amended": propositionAmendedSchema,
  "proposition.deleted": propositionDeletedSchema,
  "task.drafted": taskDraftedSchema,
  "task.created": taskCreatedSchema,
  "task.title_changed": taskTitleChangedSchema,
  "task.propositions_added": taskPropositionsAddedSchema,
  "task.propositions_removed": taskPropositionsRemovedSchema,
  "task.config_updated": taskConfigUpdatedSchema,
  "task.status_changed": taskStatusChangedSchema,
  "task.deferred": taskDeferredSchema,
  "task.archived": taskArchivedSchema,
  "task.worktree_created": taskWorktreeCreatedSchema,
  "task.worktree_deleted": taskWorktreeDeletedSchema,
  "task.dependency.set": taskDependencySetSchema,
  "task.unblocked": taskUnblockedSchema,
  "task.dependency.warning": taskDependencyWarningSchema,
  "attempt.started": attemptStartedSchema,
  "attempt.paused": attemptPausedSchema,
  "attempt.resumed": attemptResumedSchema,
  "attempt.killed": attemptKilledSchema,
  "attempt.completed": attemptCompletedSchema,
  "attempt.approved": attemptApprovedSchema,
  "attempt.rejected": attemptRejectedSchema,
  "attempt.retry_requested": attemptRetryRequestedSchema,
  "phase.started": phaseStartedSchema,
  "phase.context_packed": phaseContextPackedSchema,
  "phase.completed": phaseCompletedSchema,
  "phase.failed": phaseFailedSchema,
  "invocation.started": invocationStartedSchema,
  "invocation.assistant_message": invocationAssistantMessageSchema,
  "invocation.tool_called": invocationToolCalledSchema,
  "invocation.tool_returned": invocationToolReturnedSchema,
  "invocation.file_edited": invocationFileEditedSchema,
  "invocation.completed": invocationCompletedSchema,
  "invocation.errored": invocationErroredSchema,
  "gate.started": gateStartedSchema,
  "gate.passed": gatePassedSchema,
  "gate.failed": gateFailedSchema,
  "gate.timed_out": gateTimedOutSchema,
  "gate.skipped": gateSkippedSchema,
  "auditor.judged": auditorJudgedSchema,
  "audit.overridden": auditOverriddenSchema,
  "pushback.raised": pushbackRaisedSchema,
  "pushback.resolved": pushbackResolvedSchema,
  "prompt_version.created": promptVersionCreatedSchema,
  "prompt_version.retired": promptVersionRetiredSchema,
  "ab_experiment.created": abExperimentCreatedSchema,
  "ab_experiment.concluded": abExperimentConcludedSchema,
  "gate_library.gate_added": gateLibraryGateAddedSchema,
  "gate_library.gate_updated": gateLibraryGateUpdatedSchema,
  "gate_library.gate_removed": gateLibraryGateRemovedSchema,
  "settings.changed": settingsChangedSchema,
  "preset.created": presetCreatedSchema,
  "preset.updated": presetUpdatedSchema,
  "preset.deleted": presetDeletedSchema,
  "provider.configured": providerConfiguredSchema,
  "provider.probed": providerProbedSchema,
  "provider.auth_changed": providerAuthChangedSchema,
  "files.changed_externally": filesChangedExternallySchema,
  "classifier.selected_strategy": classifierSelectedStrategySchema,
  // Merge
  "task.merged": taskMergedSchema,
  "merge.conflicted": mergeConflictedSchema,
  "merge.gate_failed": mergeGateFailedSchema,
  "task.finalized": taskFinalizedSchema,

  // Auto-merge
  "task.auto_approved": taskAutoApprovedSchema,
  "task.auto_merged": taskAutoMergedSchema,
  "task.would_auto_merge": taskWouldAutoMergeSchema,

  // Settings — auto-merge kill switch
  "settings.auto_merge_enabled_set": settingsAutoMergeEnabledSetSchema,
};
