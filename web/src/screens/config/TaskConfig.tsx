/**
 * Task Configuration Screen — full-screen overlay at #/tasks/:id/config
 *
 * Loads the task's current config, allows editing all fields, computes
 * an override indicator against the referenced preset, and POSTs only
 * the changed diff to /api/commands/task/:id/config on save.
 */

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft } from "lucide-react";
import type { TaskDetailRow, PresetRow } from "@shared/projections.js";
import type { TaskConfig as TaskConfigType, PhaseConfig, GateConfig, RetryPolicy, RetryStrategy, Transport, AutoMergePolicy } from "@shared/events.js";
import { useGateLibraryQuery } from "../../hooks/useQueries.js";
import type { LibraryGate } from "../../hooks/useQueries.js";

// ============================================================================
// Types
// ============================================================================

type TaskConfigProps = {
  taskId: string;
  onBack: () => void;
};

type LoadState =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "loaded"; detail: TaskDetailRow };

// ============================================================================
// Diff computation
// ============================================================================

/**
 * Computes a partial TaskConfig containing only the fields that changed.
 * Returns null if nothing changed.
 */
function computeDiff(
  original: TaskConfigType,
  edited: TaskConfigType,
): Partial<TaskConfigType> | null {
  const diff: Partial<TaskConfigType> = {};

  // Check phases (compare by serialization)
  if (JSON.stringify(original.phases) !== JSON.stringify(edited.phases)) {
    diff.phases = edited.phases;
  }
  // Check gates
  if (JSON.stringify(original.gates) !== JSON.stringify(edited.gates)) {
    diff.gates = edited.gates;
  }
  // Check retry_policy (field by field)
  const rp = computeRetryPolicyDiff(original.retry_policy, edited.retry_policy);
  if (rp) diff.retry_policy = { ...original.retry_policy, ...rp };

  // Check auto-merge fields
  if ((original.auto_merge_policy ?? "off") !== (edited.auto_merge_policy ?? "off")) {
    diff.auto_merge_policy = edited.auto_merge_policy;
  }
  if ((original.shadow_mode ?? false) !== (edited.shadow_mode ?? false)) {
    diff.shadow_mode = edited.shadow_mode;
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

function computeRetryPolicyDiff(
  original: RetryPolicy,
  edited: RetryPolicy,
): Partial<RetryPolicy> | null {
  const diff: Partial<RetryPolicy> = {};
  if (JSON.stringify(original.on_typecheck_fail) !== JSON.stringify(edited.on_typecheck_fail))
    diff.on_typecheck_fail = edited.on_typecheck_fail;
  if (JSON.stringify(original.on_test_fail) !== JSON.stringify(edited.on_test_fail))
    diff.on_test_fail = edited.on_test_fail;
  if (original.on_audit_reject !== edited.on_audit_reject)
    diff.on_audit_reject = edited.on_audit_reject;
  if (original.on_spec_pushback !== edited.on_spec_pushback)
    diff.on_spec_pushback = edited.on_spec_pushback;
  if (original.max_total_attempts !== edited.max_total_attempts)
    diff.max_total_attempts = edited.max_total_attempts;
  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Count override keys: fields that differ from the referenced preset.
 * Returns 0 when no preset is selected.
 */
function countOverrides(edited: TaskConfigType, preset: PresetRow | null): number {
  if (!preset) return 0;
  let count = 0;
  const p = preset.config;

  // Count phase-level overrides
  for (const phase of edited.phases) {
    const presetPhase = p.phases.find((ph) => ph.name === phase.name);
    if (!presetPhase) { count++; continue; }
    if (phase.enabled !== presetPhase.enabled) count++;
    if (phase.transport !== presetPhase.transport) count++;
    if (phase.model !== presetPhase.model) count++;
    if (phase.prompt_version_id !== presetPhase.prompt_version_id) count++;
    if (JSON.stringify(phase.transport_options) !== JSON.stringify(presetPhase.transport_options)) count++;
  }

  // Count gate overrides
  if (JSON.stringify(edited.gates) !== JSON.stringify(p.gates)) count++;

  // Count retry policy overrides
  const rpDiff = computeRetryPolicyDiff(p.retry_policy, edited.retry_policy);
  if (rpDiff) count += Object.keys(rpDiff).length;

  // Count auto-merge overrides
  if ((edited.auto_merge_policy ?? "off") !== (p.auto_merge_policy ?? "off")) count++;
  if ((edited.shadow_mode ?? false) !== (p.shadow_mode ?? false)) count++;

  return count;
}

// ============================================================================
// Available options
// ============================================================================

const TRANSPORTS: Transport[] = [
  "claude-code",
  "anthropic-api",
  "openai-api",
  "codex",
  "aider",
  "gemini-cli",
];

const MODELS_BY_TRANSPORT: Record<Transport, string[]> = {
  "claude-code": ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
  "anthropic-api": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  "openai-api": ["gpt-4o", "gpt-4-turbo", "o3"],
  "codex": ["codex-default"],
  "aider": ["aider-default"],
  "gemini-cli": ["gemini-2.5-pro", "gemini-2.0-flash"],
};

const RETRY_STRATEGIES: RetryStrategy[] = [
  "retry_same",
  "retry_with_more_context",
  "reroute_to_stronger_model",
  "decompose_task",
  "escalate_to_human",
];

const ON_FAIL_OPTIONS: GateConfig["on_fail"][] = [
  "retry",
  "retry_with_context",
  "skip",
  "fail_task",
];

const AUTO_MERGE_POLICIES: AutoMergePolicy[] = [
  "off",
  "on_full_pass",
  "on_auditor_approve",
];

// ============================================================================
// Override pill
// ============================================================================

function OverridePill({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-status-warning/15 text-status-warning">
      override{label ? ` · ${label}` : ""}
    </span>
  );
}

// ============================================================================
// Section header
// ============================================================================

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-3">
      {title}
    </h3>
  );
}

// ============================================================================
// Phase card
// ============================================================================

function PhaseCard({
  phase,
  index,
  presetPhase,
  gateNames,
  onChange,
}: {
  phase: PhaseConfig;
  index: number;
  presetPhase?: PhaseConfig;
  gateNames: string[];
  onChange: (index: number, updated: PhaseConfig) => void;
}) {
  const update = (patch: Partial<PhaseConfig>) => onChange(index, { ...phase, ...patch });
  const models = MODELS_BY_TRANSPORT[phase.transport] ?? [];

  const isOverride = (field: keyof PhaseConfig) =>
    presetPhase ? JSON.stringify(phase[field]) !== JSON.stringify(presetPhase[field]) : false;

  return (
    <div className="border border-border-default bg-bg-secondary p-4">
      {/* Phase name + enabled toggle */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-text-primary">{phase.name}</span>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={phase.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="h-4 w-4 accent-status-healthy"
          />
          <span className="text-xs text-text-secondary">enabled</span>
          {isOverride("enabled") && <OverridePill />}
        </label>
      </div>

      {/* Transport select */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor={`transport-${index}`}
            className="block text-xs text-text-secondary mb-1"
          >
            Transport
          </label>
          <div className="flex items-center gap-1.5">
            <select
              id={`transport-${index}`}
              value={phase.transport}
              onChange={(e) =>
                update({
                  transport: e.target.value as Transport,
                  model: MODELS_BY_TRANSPORT[e.target.value as Transport]?.[0] ?? phase.model,
                })
              }
              className="flex-1 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            >
              {TRANSPORTS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            {isOverride("transport") && <OverridePill />}
          </div>
        </div>

        {/* Model select */}
        <div>
          <label
            htmlFor={`model-${index}`}
            className="block text-xs text-text-secondary mb-1"
          >
            Model
          </label>
          <div className="flex items-center gap-1.5">
            <select
              id={`model-${index}`}
              value={phase.model}
              onChange={(e) => update({ model: e.target.value })}
              aria-label="model"
              className="flex-1 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              {/* Allow current model even if not in list */}
              {!models.includes(phase.model) && (
                <option value={phase.model}>{phase.model}</option>
              )}
            </select>
            {isOverride("model") && <OverridePill />}
          </div>
        </div>
      </div>

      {/* Prompt version */}
      <div className="mt-3">
        <label
          htmlFor={`prompt-${index}`}
          className="block text-xs text-text-secondary mb-1"
        >
          Prompt version
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id={`prompt-${index}`}
            type="text"
            value={phase.prompt_version_id}
            onChange={(e) => update({ prompt_version_id: e.target.value })}
            className="flex-1 border border-border-default bg-bg-primary px-2 py-1.5 font-mono text-xs text-text-primary"
          />
          {isOverride("prompt_version_id") && <OverridePill />}
        </div>
      </div>

      {/* CLI transport options */}
      {phase.transport_options.kind === "cli" && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Max turns</label>
            <input
              type="number"
              min={1}
              value={phase.transport_options.max_turns}
              onChange={(e) =>
                update({
                  transport_options: {
                    ...phase.transport_options,
                    kind: "cli",
                    max_turns: Number(e.target.value),
                  } as typeof phase.transport_options,
                })
              }
              className="w-full border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Budget USD</label>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={phase.transport_options.max_budget_usd}
              onChange={(e) =>
                update({
                  transport_options: {
                    ...phase.transport_options,
                    kind: "cli",
                    max_budget_usd: Number(e.target.value),
                  } as typeof phase.transport_options,
                })
              }
              className="w-full border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Permission</label>
            <select
              value={phase.transport_options.permission_mode}
              onChange={(e) =>
                update({
                  transport_options: {
                    ...phase.transport_options,
                    kind: "cli",
                    permission_mode: e.target.value as "acceptEdits" | "acceptAll" | "plan" | "default",
                  } as typeof phase.transport_options,
                })
              }
              className="w-full border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            >
              {(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"] as const).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* API transport options */}
      {phase.transport_options.kind === "api" && (
        <div className="mt-3">
          <label className="block text-xs text-text-secondary mb-1">Max tokens</label>
          <input
            type="number"
            min={256}
            value={phase.transport_options.max_tokens}
            onChange={(e) =>
              update({
                transport_options: {
                  ...phase.transport_options,
                  kind: "api",
                  max_tokens: Number(e.target.value),
                } as typeof phase.transport_options,
              })
            }
            className="w-24 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
          />
        </div>
      )}

      {/* Skip gates */}
      {gateNames.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-xs text-text-secondary">Skip gates</span>
            {isOverride("skip_gates") && <OverridePill />}
          </div>
          <div className="flex flex-wrap gap-2">
            {gateNames.map((name) => {
              const skipped = phase.skip_gates?.includes(name) ?? false;
              return (
                <label key={name} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipped}
                    onChange={(e) => {
                      const current = phase.skip_gates ?? [];
                      const next = e.target.checked
                        ? [...current, name]
                        : current.filter((g) => g !== name);
                      update({ skip_gates: next.length > 0 ? next : undefined });
                    }}
                    className="h-3.5 w-3.5 accent-status-warning"
                  />
                  <span className="text-xs font-mono text-text-primary">{name}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Gates table
// ============================================================================

function GatesTable({
  gates,
  presetGates,
  libraryGates,
  onChange,
}: {
  gates: GateConfig[];
  presetGates: GateConfig[];
  libraryGates: LibraryGate[];
  onChange: (gates: GateConfig[]) => void;
}) {
  const enabledNames = new Set(gates.map((g) => g.name));

  const updateGate = (index: number, patch: Partial<GateConfig>) => {
    const next = gates.map((g, i) => (i === index ? { ...g, ...patch } : g));
    onChange(next);
  };

  // Toggle a library gate on/off for this task
  const toggleGate = (libGate: LibraryGate) => {
    if (enabledNames.has(libGate.name)) {
      // Remove from task config
      onChange(gates.filter((g) => g.name !== libGate.name));
    } else {
      // Add library gate definition to task config
      const { source: _, ...gateConfig } = libGate;
      onChange([...gates, gateConfig]);
    }
  };

  const gatesChanged = JSON.stringify(gates) !== JSON.stringify(presetGates);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <SectionHeader title="Gates" />
        {gatesChanged && <OverridePill />}
      </div>

      {/* Gate library — all available gates with enable/disable toggle */}
      {libraryGates.length > 0 ? (
        <div className="border border-border-default overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-muted bg-bg-secondary">
                <th className="px-4 py-2 w-10" />
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">Name</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">Command</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">Required</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">Timeout</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">On fail</th>
              </tr>
            </thead>
            <tbody>
              {libraryGates.map((libGate) => {
                const enabled = enabledNames.has(libGate.name);
                const taskGateIndex = gates.findIndex((g) => g.name === libGate.name);

                return (
                  <tr
                    key={libGate.name}
                    className={`border-b border-border-muted last:border-b-0 ${!enabled ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => toggleGate(libGate)}
                        className="h-4 w-4 accent-status-healthy"
                        title={enabled ? "Disable gate for this task" : "Enable gate for this task"}
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-text-primary">{libGate.name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-text-secondary">{libGate.command}</td>
                    <td className="px-4 py-2">
                      {enabled && taskGateIndex >= 0 ? (
                        <input
                          type="checkbox"
                          checked={gates[taskGateIndex].required}
                          onChange={(e) => updateGate(taskGateIndex, { required: e.target.checked })}
                          className="h-4 w-4 accent-status-healthy"
                        />
                      ) : (
                        <span className="text-xs text-text-tertiary">{libGate.required ? "yes" : "no"}</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {enabled && taskGateIndex >= 0 ? (
                        <input
                          type="number"
                          min={1}
                          value={gates[taskGateIndex].timeout_seconds}
                          onChange={(e) => updateGate(taskGateIndex, { timeout_seconds: Number(e.target.value) })}
                          className="w-16 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
                        />
                      ) : (
                        <span className="text-xs text-text-tertiary">{libGate.timeout_seconds}s</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {enabled && taskGateIndex >= 0 ? (
                        <select
                          value={gates[taskGateIndex].on_fail}
                          onChange={(e) => updateGate(taskGateIndex, { on_fail: e.target.value as GateConfig["on_fail"] })}
                          className="border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
                        >
                          {ON_FAIL_OPTIONS.map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-text-tertiary">{libGate.on_fail}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-text-tertiary">
          No gates in the library. Add gates in Settings → Gates.
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Retry policy section
// ============================================================================

function RetryPolicySection({
  policy,
  presetPolicy,
  onChange,
}: {
  policy: RetryPolicy;
  presetPolicy: RetryPolicy;
  onChange: (policy: RetryPolicy) => void;
}) {
  const update = (patch: Partial<RetryPolicy>) => onChange({ ...policy, ...patch });

  const isOverride = <K extends keyof RetryPolicy>(key: K) =>
    JSON.stringify(policy[key]) !== JSON.stringify(presetPolicy[key]);

  return (
    <div>
      <SectionHeader title="Retry Policy" />
      <div className="border border-border-default bg-bg-secondary p-4 grid grid-cols-2 gap-4">
        {/* Max total attempts */}
        <div>
          <label
            htmlFor="max-total-attempts"
            className="block text-xs text-text-secondary mb-1"
          >
            Max total attempts
          </label>
          <div className="flex items-center gap-2">
            <input
              id="max-total-attempts"
              type="number"
              min={1}
              max={20}
              value={policy.max_total_attempts}
              onChange={(e) => update({ max_total_attempts: Number(e.target.value) })}
              className="w-20 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            />
            {isOverride("max_total_attempts") && <OverridePill />}
          </div>
        </div>

        {/* On audit reject */}
        <div>
          <label htmlFor="on-audit-reject" className="block text-xs text-text-secondary mb-1">
            On audit reject
          </label>
          <div className="flex items-center gap-2">
            <select
              id="on-audit-reject"
              value={policy.on_audit_reject}
              onChange={(e) => update({ on_audit_reject: e.target.value as RetryStrategy })}
              className="border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            >
              {RETRY_STRATEGIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {isOverride("on_audit_reject") && <OverridePill />}
          </div>
        </div>

        {/* On typecheck fail */}
        <div>
          <label htmlFor="on-typecheck-strategy" className="block text-xs text-text-secondary mb-1">
            On typecheck fail
          </label>
          <div className="flex items-center gap-2">
            <select
              id="on-typecheck-strategy"
              value={policy.on_typecheck_fail.strategy}
              onChange={(e) =>
                update({
                  on_typecheck_fail: {
                    ...policy.on_typecheck_fail,
                    strategy: e.target.value as RetryStrategy,
                  },
                })
              }
              className="border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            >
              {RETRY_STRATEGIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              value={policy.on_typecheck_fail.max_attempts}
              onChange={(e) =>
                update({
                  on_typecheck_fail: {
                    ...policy.on_typecheck_fail,
                    max_attempts: Number(e.target.value),
                  },
                })
              }
              className="w-14 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
              placeholder="max"
            />
            {isOverride("on_typecheck_fail") && <OverridePill />}
          </div>
        </div>

        {/* On test fail */}
        <div>
          <label htmlFor="on-test-strategy" className="block text-xs text-text-secondary mb-1">
            On test fail
          </label>
          <div className="flex items-center gap-2">
            <select
              id="on-test-strategy"
              value={policy.on_test_fail.strategy}
              onChange={(e) =>
                update({
                  on_test_fail: {
                    ...policy.on_test_fail,
                    strategy: e.target.value as RetryStrategy,
                  },
                })
              }
              className="border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            >
              {RETRY_STRATEGIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              value={policy.on_test_fail.max_attempts}
              onChange={(e) =>
                update({
                  on_test_fail: {
                    ...policy.on_test_fail,
                    max_attempts: Number(e.target.value),
                  },
                })
              }
              className="w-14 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
              placeholder="max"
            />
            {isOverride("on_test_fail") && <OverridePill />}
          </div>
        </div>

        {/* On spec pushback */}
        <div>
          <label htmlFor="on-spec-pushback" className="block text-xs text-text-secondary mb-1">
            On spec pushback
          </label>
          <div className="flex items-center gap-2">
            <select
              id="on-spec-pushback"
              value={policy.on_spec_pushback}
              onChange={(e) =>
                update({ on_spec_pushback: e.target.value as RetryPolicy["on_spec_pushback"] })
              }
              className="border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            >
              <option value="pause_and_notify">pause_and_notify</option>
              <option value="auto_defer">auto_defer</option>
            </select>
            {isOverride("on_spec_pushback") && <OverridePill />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Auto-merge section
// ============================================================================

function AutoMergeSection({
  policy,
  shadowMode,
  presetPolicy,
  presetShadowMode,
  onPolicyChange,
  onShadowModeChange,
}: {
  policy: AutoMergePolicy;
  shadowMode: boolean;
  presetPolicy: AutoMergePolicy;
  presetShadowMode: boolean;
  onPolicyChange: (p: AutoMergePolicy) => void;
  onShadowModeChange: (v: boolean) => void;
}) {
  const policyOverride = policy !== presetPolicy;
  const shadowOverride = shadowMode !== presetShadowMode;

  return (
    <div>
      <SectionHeader title="Auto-merge" />
      <div className="border border-border-default bg-bg-secondary p-4 space-y-4">
        {/* Policy select */}
        <div>
          <label
            htmlFor="auto-merge-policy"
            className="block text-xs text-text-secondary mb-1"
          >
            Auto-merge policy
          </label>
          <div className="flex items-center gap-2">
            <select
              id="auto-merge-policy"
              value={policy}
              onChange={(e) => onPolicyChange(e.target.value as AutoMergePolicy)}
              className="border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            >
              {AUTO_MERGE_POLICIES.map((p) => (
                <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
              ))}
            </select>
            {policyOverride && <OverridePill />}
          </div>
        </div>

        {/* Shadow mode toggle */}
        <label className="flex items-center gap-2 cursor-pointer" htmlFor="shadow-mode">
          <input
            id="shadow-mode"
            type="checkbox"
            checked={shadowMode}
            onChange={(e) => onShadowModeChange(e.target.checked)}
            className="h-4 w-4 accent-status-healthy"
          />
          <span className="text-sm text-text-primary">Shadow mode</span>
          {shadowOverride && <OverridePill />}
        </label>
        <p className="text-xs text-text-tertiary pl-6 -mt-2">
          Evaluate but do not merge — useful for trial runs.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Save-as-preset modal (simple prompt)
// ============================================================================

function SaveAsPresetModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (name: string, taskClass: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [taskClass, setTaskClass] = useState("feature");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="border border-border-default bg-bg-primary p-6 shadow-xl w-full max-w-sm">
        <h3 className="text-base font-semibold text-text-primary mb-4">Save as preset</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Preset name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. my-api-feature"
              className="w-full border border-border-default bg-bg-secondary px-3 py-2 text-sm text-text-primary"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Task class</label>
            <select
              value={taskClass}
              onChange={(e) => setTaskClass(e.target.value)}
              className="w-full border border-border-default bg-bg-secondary px-3 py-2 text-sm text-text-primary"
            >
              <option value="feature">feature</option>
              <option value="bugfix">bugfix</option>
              <option value="refactor">refactor</option>
              <option value="migration">migration</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="border border-border-default px-4 py-1.5 text-sm text-text-secondary hover:bg-bg-secondary transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => onConfirm(name.trim(), taskClass)}
            className="bg-bg-inverse px-4 py-1.5 text-sm text-text-inverse hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create preset
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

export function TaskConfig({ taskId, onBack }: TaskConfigProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [editedConfig, setEditedConfig] = useState<TaskConfigType | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [showSaveAsPreset, setShowSaveAsPreset] = useState(false);

  // Fetch gate library via TanStack Query
  const gateLibraryQuery = useGateLibraryQuery();
  const libraryGates = gateLibraryQuery.data?.all_gates ?? [];

  // Load task detail and presets in parallel
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch(`/api/projections/task_detail/${taskId}`).then((r) =>
        r.ok ? (r.json() as Promise<TaskDetailRow>) : null,
      ),
      fetch("/api/projections/preset").then((r) =>
        r.ok ? (r.json() as Promise<PresetRow[]>) : [],
      ),
    ]).then(([detail, presetRows]) => {
      if (cancelled) return;
      if (!detail) {
        setLoadState({ status: "not_found" });
        return;
      }
      setPresets(presetRows ?? []);
      setEditedConfig(JSON.parse(JSON.stringify(detail.config))); // deep copy
      setSelectedPresetId(detail.preset_id);
      setLoadState({ status: "loaded", detail });
    });

    return () => { cancelled = true; };
  }, [taskId]);

  const selectedPreset = presets.find((p) => p.preset_id === selectedPresetId) ?? null;
  const overrideCount = editedConfig ? countOverrides(editedConfig, selectedPreset) : 0;

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (loadState.status !== "loaded" || !editedConfig) return;
    setSaving(true);

    const originalConfig = loadState.detail.config;
    const diff = computeDiff(originalConfig, editedConfig) ?? {};

    await fetch(`/api/commands/task/${taskId}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config_diff: diff, reason: "User edit via config modal" }),
    });

    setSaving(false);
    onBack();
  }, [loadState, editedConfig, taskId, onBack]);

  // ── Save-as-preset ─────────────────────────────────────────────────────────

  const handleSaveAsPreset = useCallback(
    async (name: string, taskClass: string) => {
      if (!editedConfig) return;
      setShowSaveAsPreset(false);

      await fetch("/api/commands/preset/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, task_class: taskClass, config: editedConfig }),
      });
    },
    [editedConfig],
  );

  // ── Phase updates ──────────────────────────────────────────────────────────

  const updatePhase = useCallback((index: number, updated: PhaseConfig) => {
    setEditedConfig((prev) => {
      if (!prev) return prev;
      const phases = prev.phases.map((p, i) => (i === index ? updated : p));
      return { ...prev, phases };
    });
  }, []);

  const updateGates = useCallback((gates: GateConfig[]) => {
    setEditedConfig((prev) => prev ? { ...prev, gates } : prev);
  }, []);

  const updateRetryPolicy = useCallback((policy: RetryPolicy) => {
    setEditedConfig((prev) => prev ? { ...prev, retry_policy: policy } : prev);
  }, []);

  // ── Render states ──────────────────────────────────────────────────────────

  if (loadState.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-text-secondary">Loading…</span>
      </div>
    );
  }

  if (loadState.status === "not_found") {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-text-secondary">Task not found.</span>
      </div>
    );
  }

  const { detail } = loadState;

  return (
    <>
      {showSaveAsPreset && (
        <SaveAsPresetModal
          onConfirm={handleSaveAsPreset}
          onCancel={() => setShowSaveAsPreset(false)}
        />
      )}

      <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
        {/* ── Top bar ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 border-b border-border-muted px-4 py-3 flex-shrink-0">
          <button
            type="button"
            aria-label="back"
            onClick={onBack}
            className="p-1.5 hover:bg-bg-secondary transition-colors cursor-pointer"
          >
            <ChevronLeft className="h-4 w-4 text-text-secondary" />
          </button>

          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xs font-medium text-text-secondary">Configure task</span>
            <span className="text-xs text-text-tertiary font-mono">{detail.task_id}</span>
            <span className="text-sm font-semibold text-text-primary truncate">{detail.title}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="border border-border-default px-4 py-1.5 text-sm text-text-secondary hover:bg-bg-secondary transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-bg-inverse px-4 py-1.5 text-sm text-text-inverse hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {/* ── Preset strip ────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 border-b border-border-muted px-4 py-2.5 bg-bg-secondary flex-shrink-0">
          <label className="text-xs text-text-secondary">Preset:</label>
          <select
            value={selectedPresetId ?? ""}
            onChange={(e) => setSelectedPresetId(e.target.value || undefined)}
            className="border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
          >
            <option value="">— none —</option>
            {presets.map((p) => (
              <option key={p.preset_id} value={p.preset_id}>{p.name}</option>
            ))}
          </select>

          <span className="rounded-full border border-border-default px-2.5 py-0.5 text-xs text-text-secondary">
            {overrideCount} {overrideCount === 1 ? "override" : "overrides"}
          </span>

          <button
            type="button"
            onClick={() => setShowSaveAsPreset(true)}
            className="ml-auto border border-border-default px-3 py-1 text-xs text-text-secondary hover:bg-bg-primary transition-colors cursor-pointer"
          >
            Save as preset
          </button>
        </div>

        {/* ── Scrollable body ─────────────────────────────────────────────── */}
        {editedConfig && (
          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            {/* PHASES */}
            <section>
              <SectionHeader title="Phases" />
              <div className="space-y-3">
                {editedConfig.phases.map((phase, i) => (
                  <PhaseCard
                    key={phase.name}
                    phase={phase}
                    index={i}
                    presetPhase={selectedPreset?.config.phases.find((p) => p.name === phase.name)}
                    gateNames={editedConfig.gates.map((g) => g.name)}
                    onChange={updatePhase}
                  />
                ))}
              </div>
            </section>

            {/* GATES */}
            <section>
              <GatesTable
                gates={editedConfig.gates}
                presetGates={selectedPreset?.config.gates ?? editedConfig.gates}
                libraryGates={libraryGates}
                onChange={updateGates}
              />
            </section>

            {/* RETRY POLICY */}
            <section>
              <RetryPolicySection
                policy={editedConfig.retry_policy}
                presetPolicy={selectedPreset?.config.retry_policy ?? editedConfig.retry_policy}
                onChange={updateRetryPolicy}
              />
            </section>

            {/* AUTO-MERGE */}
            <section>
              <AutoMergeSection
                policy={editedConfig.auto_merge_policy ?? "off"}
                shadowMode={editedConfig.shadow_mode ?? false}
                presetPolicy={selectedPreset?.config.auto_merge_policy ?? "off"}
                presetShadowMode={selectedPreset?.config.shadow_mode ?? false}
                onPolicyChange={(p) =>
                  setEditedConfig((prev) => prev ? { ...prev, auto_merge_policy: p } : prev)
                }
                onShadowModeChange={(v) =>
                  setEditedConfig((prev) => prev ? { ...prev, shadow_mode: v } : prev)
                }
              />
            </section>
          </div>
        )}
      </div>
    </>
  );
}
