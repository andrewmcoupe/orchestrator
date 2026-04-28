/**
 * Task Configuration Screen — full-screen overlay at #/tasks/:id/config
 *
 * Loads the task's current config, allows editing all fields, computes
 * an override indicator against the referenced preset, and POSTs only
 * the changed diff to /api/commands/task/:id/config on save.
 */

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, Eye } from "lucide-react";
import type { TaskDetailRow, PresetRow } from "@shared/projections.js";
import type {
  TaskConfig as TaskConfigType,
  PhaseConfig,
  GateConfig,
  RetryPolicy,
  Transport,
  AutoMergePolicy,
} from "@shared/events.js";
import {
  useGateLibraryQuery,
  usePromptLibraryQuery,
  usePromptTemplateQuery,
} from "../../hooks/useQueries.js";
import type { LibraryGate } from "../../hooks/useQueries.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
} from "../../components/ui/card.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";

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
  if (
    (original.auto_merge_policy ?? "off") !==
    (edited.auto_merge_policy ?? "off")
  ) {
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
  if (
    JSON.stringify(original.on_typecheck_fail) !==
    JSON.stringify(edited.on_typecheck_fail)
  )
    diff.on_typecheck_fail = edited.on_typecheck_fail;
  if (
    JSON.stringify(original.on_test_fail) !==
    JSON.stringify(edited.on_test_fail)
  )
    diff.on_test_fail = edited.on_test_fail;
  if (original.on_audit_reject !== edited.on_audit_reject)
    diff.on_audit_reject = edited.on_audit_reject;
  if (original.on_spec_pushback !== edited.on_spec_pushback)
    diff.on_spec_pushback = edited.on_spec_pushback;
  if (original.max_total_attempts !== edited.max_total_attempts)
    diff.max_total_attempts = edited.max_total_attempts;
  return Object.keys(diff).length > 0 ? diff : null;
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
  codex: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.5"],
  aider: ["aider-default"],
  "gemini-cli": ["gemini-2.5-pro", "gemini-2.0-flash"],
};

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

// ============================================================================
// Section header
// ============================================================================

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground mb-3">
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
  gateNames,
  onChange,
}: {
  phase: PhaseConfig;
  index: number;
  gateNames: string[];
  onChange: (index: number, updated: PhaseConfig) => void;
}) {
  const update = (patch: Partial<PhaseConfig>) =>
    onChange(index, { ...phase, ...patch });
  const models = MODELS_BY_TRANSPORT[phase.transport] ?? [];
  const { data: prompts } = usePromptLibraryQuery(phase.name);
  const activePrompts = (prompts ?? []).filter((p) => !p.retired);
  const { data: templateData } = usePromptTemplateQuery(
    phase.prompt_version_id,
  );

  return (
    <Card className="flex-1" size="sm">
      <CardHeader>
        <CardTitle>{phase.name}</CardTitle>
        <CardAction>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={phase.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
              className="h-4 w-4 accent-status-healthy"
            />
            <span className="text-xs text-text-secondary">enabled</span>
          </label>
        </CardAction>
      </CardHeader>

      <CardContent>
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
              <Select
                value={phase.transport}
                onValueChange={(val) => {
                  if (!val) return;
                  const newTransport = val as Transport;
                  const isCli = [
                    "claude-code",
                    "codex",
                    "aider",
                    "gemini-cli",
                  ].includes(newTransport);
                  const wasCli = phase.transport_options.kind === "cli";
                  update({
                    transport: newTransport,
                    model:
                      MODELS_BY_TRANSPORT[newTransport]?.[0] ?? phase.model,
                    transport_options:
                      isCli && !wasCli
                        ? {
                            kind: "cli" as const,
                            max_turns: 10,
                            max_budget_usd: 5,
                            permission_mode: "acceptEdits" as const,
                          }
                        : !isCli && wasCli
                          ? { kind: "api" as const, max_tokens: 4096 }
                          : phase.transport_options,
                  });
                }}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSPORTS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Select
                value={phase.model}
                onValueChange={(val) => {
                  if (val) update({ model: val });
                }}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                  {!models.includes(phase.model) && (
                    <SelectItem value={phase.model}>{phase.model}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Prompt version */}
        <div className="mt-3 mb-6">
          <label className="block text-xs text-text-secondary mb-1">
            Prompt version
          </label>
          <div className="flex items-center gap-1.5">
            <Select
              value={phase.prompt_version_id}
              onValueChange={(val) => {
                if (val) update({ prompt_version_id: val });
              }}
            >
              <SelectTrigger className="flex-1 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {activePrompts.map((p) => (
                  <SelectItem
                    key={p.prompt_version_id}
                    value={p.prompt_version_id}
                  >
                    {p.name} ({p.prompt_version_id.slice(0, 8)})
                  </SelectItem>
                ))}
                {!activePrompts.some(
                  (p) => p.prompt_version_id === phase.prompt_version_id,
                ) && (
                  <SelectItem value={phase.prompt_version_id}>
                    {phase.prompt_version_id}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {templateData?.template && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger className="text-text-tertiary hover:text-text-secondary transition-colors">
                    <Eye className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className="max-w-lg max-h-[70dvh] overflow-y-auto"
                  >
                    <pre className="text-[10px] leading-tight whitespace-pre-wrap break-words">
                      {templateData.template}
                    </pre>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        {/* CLI transport options */}
        {phase.transport_options.kind === "cli" && (
          <div className="mt-3 border p-2">
            <span className="block text-xs font-medium text-foreground mb-1">
              Agent guardrails
            </span>
            <p className="text-[11px] text-muted-foreground mb-4">
              Safety limits for this phase. The defaults are sensible for most
              tasks — only adjust if you need longer runs or tighter cost
              control.
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  Max turns
                </label>
                <input
                  type="number"
                  min={1}
                  value={phase.transport_options.max_turns ?? 10}
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
                <label className="block text-xs text-text-secondary mb-1">
                  Budget USD
                </label>
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
                <label className="block text-xs text-text-secondary mb-1">
                  Permission
                </label>
                <Select
                  value={phase.transport_options.permission_mode}
                  onValueChange={(val) => {
                    if (!val) return;
                    update({
                      transport_options: {
                        ...phase.transport_options,
                        kind: "cli",
                        permission_mode: val as
                          | "acceptEdits"
                          | "acceptAll"
                          | "plan"
                          | "default",
                      } as typeof phase.transport_options,
                    });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      ["default", "acceptEdits", "bypassPermissions"] as const
                    ).map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        {/* API transport options */}
        {phase.transport_options.kind === "api" && (
          <div className="mt-3 border p-2">
            <span className="block text-xs font-medium text-foreground mb-1">
              API limits
            </span>
            <p className="text-[11px] text-muted-foreground mb-2">
              When using the API transport, the model receives your prompt and
              responds in a single pass — there is no multi-turn tool use. Max
              tokens controls the upper bound on how long that response can be.
            </p>
            <label className="block text-xs text-text-secondary mb-1">
              Max tokens
            </label>
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
            </div>
            <div className="flex flex-wrap gap-2">
              {gateNames.map((name) => {
                const skipped = phase.skip_gates?.includes(name) ?? false;
                return (
                  <label
                    key={name}
                    className="flex items-center gap-1.5 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={skipped}
                      onChange={(e) => {
                        const current = phase.skip_gates ?? [];
                        const next = e.target.checked
                          ? [...current, name]
                          : current.filter((g) => g !== name);
                        update({
                          skip_gates: next.length > 0 ? next : undefined,
                        });
                      }}
                      className="h-3.5 w-3.5 accent-status-warning"
                    />
                    <span className="text-xs font-mono text-text-primary">
                      {name}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Gates table
// ============================================================================

function GatesTable({
  gates,
  libraryGates,
  onChange,
}: {
  gates: GateConfig[];
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

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <SectionHeader title="Gates" />
      </div>

      {/* Gate library — all available gates with enable/disable toggle */}
      {libraryGates.length > 0 ? (
        <div className="border border-border-default overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-muted bg-bg-secondary">
                <th className="px-4 py-2 w-10" />
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">
                  Name
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">
                  Command
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">
                  Required
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">
                  Timeout
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-text-secondary">
                  On fail
                </th>
              </tr>
            </thead>
            <tbody>
              {libraryGates.map((libGate) => {
                const enabled = enabledNames.has(libGate.name);
                const taskGateIndex = gates.findIndex(
                  (g) => g.name === libGate.name,
                );

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
                        title={
                          enabled
                            ? "Disable gate for this task"
                            : "Enable gate for this task"
                        }
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-text-primary">
                      {libGate.name}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                      {libGate.command}
                    </td>
                    <td className="px-4 py-2">
                      {enabled && taskGateIndex >= 0 ? (
                        <input
                          type="checkbox"
                          checked={gates[taskGateIndex].required}
                          onChange={(e) =>
                            updateGate(taskGateIndex, {
                              required: e.target.checked,
                            })
                          }
                          className="h-4 w-4 accent-status-healthy"
                        />
                      ) : (
                        <span className="text-xs text-text-tertiary">
                          {libGate.required ? "yes" : "no"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {enabled && taskGateIndex >= 0 ? (
                        <input
                          type="number"
                          min={1}
                          value={gates[taskGateIndex].timeout_seconds}
                          onChange={(e) =>
                            updateGate(taskGateIndex, {
                              timeout_seconds: Number(e.target.value),
                            })
                          }
                          className="w-16 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
                        />
                      ) : (
                        <span className="text-xs text-text-tertiary">
                          {libGate.timeout_seconds}s
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {enabled && taskGateIndex >= 0 ? (
                        <Select
                          value={gates[taskGateIndex].on_fail}
                          onValueChange={(val) => {
                            if (val)
                              updateGate(taskGateIndex, {
                                on_fail: val as GateConfig["on_fail"],
                              });
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ON_FAIL_OPTIONS.map((o) => (
                              <SelectItem key={o} value={o}>
                                {o}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-text-tertiary">
                          {libGate.on_fail}
                        </span>
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
  onChange,
}: {
  policy: RetryPolicy;
  onChange: (policy: RetryPolicy) => void;
}) {
  return (
    <div>
      <SectionHeader title="Retry Policy" />
      <Card size="sm">
        <CardHeader>
          <CardTitle>Attempt limits</CardTitle>
          <CardDescription className="max-w-[100ch] mb-2">
            Limits how many times you can retry a failed attempt. Once this
            number is reached the task is locked and no further retries are
            allowed unless you update the configuration.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <label
              htmlFor="max-total-attempts"
              className="text-xs text-text-secondary"
            >
              Max attempts
            </label>
            <input
              id="max-total-attempts"
              type="number"
              min={1}
              max={20}
              value={policy.max_total_attempts}
              onChange={(e) =>
                onChange({
                  ...policy,
                  max_total_attempts: Number(e.target.value),
                })
              }
              className="w-20 border border-border-default bg-bg-primary px-2 py-1 text-sm text-text-primary"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// Auto-merge section
// ============================================================================

function AutoMergeSection({
  policy,
  shadowMode,
  onPolicyChange,
  onShadowModeChange,
}: {
  policy: AutoMergePolicy;
  shadowMode: boolean;
  onPolicyChange: (p: AutoMergePolicy) => void;
  onShadowModeChange: (v: boolean) => void;
}) {
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
            <Select
              value={policy}
              onValueChange={(val) => {
                if (val) onPolicyChange(val as AutoMergePolicy);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTO_MERGE_POLICIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Shadow mode toggle */}
        <label
          className="flex items-center gap-2 cursor-pointer"
          htmlFor="shadow-mode"
        >
          <input
            id="shadow-mode"
            type="checkbox"
            checked={shadowMode}
            onChange={(e) => onShadowModeChange(e.target.checked)}
            className="h-4 w-4 accent-status-healthy"
          />
          <span className="text-sm text-foreground">Shadow mode</span>
        </label>
        <p className="text-xs text-muted-foreground pl-6 -mt-2">
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
        <h3 className="text-base font-semibold text-text-primary mb-4">
          Save as preset
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-text-secondary mb-1">
              Preset name
            </label>
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
            <label className="block text-xs text-text-secondary mb-1">
              Task class
            </label>
            <Select
              value={taskClass}
              onValueChange={(val) => {
                if (val) setTaskClass(val);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feature">feature</SelectItem>
                <SelectItem value="bugfix">bugfix</SelectItem>
                <SelectItem value="refactor">refactor</SelectItem>
                <SelectItem value="migration">migration</SelectItem>
              </SelectContent>
            </Select>
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
  const [selectedPresetId, setSelectedPresetId] = useState<
    string | undefined
  >();
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
      fetch("/api/settings/defaults").then((r) =>
        r.ok ? (r.json() as Promise<{ default_preset_id: string | null }>) : null,
      ),
    ]).then(([detail, presetRows, defaults]) => {
      if (cancelled) return;
      if (!detail) {
        setLoadState({ status: "not_found" });
        return;
      }
      const allPresets = presetRows ?? [];
      setPresets(allPresets);

      const presetId = detail.preset_id ?? defaults?.default_preset_id ?? undefined;
      setSelectedPresetId(presetId);

      // If the task has no preset but a default is configured, apply the default preset's config
      if (!detail.preset_id && presetId) {
        const defaultPreset = allPresets.find((p) => p.preset_id === presetId);
        if (defaultPreset) {
          setEditedConfig(JSON.parse(JSON.stringify(defaultPreset.config)));
        } else {
          setEditedConfig(JSON.parse(JSON.stringify(detail.config)));
        }
      } else {
        setEditedConfig(JSON.parse(JSON.stringify(detail.config)));
      }

      setLoadState({ status: "loaded", detail });
    });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (loadState.status !== "loaded" || !editedConfig) return;
    setSaving(true);

    const originalConfig = loadState.detail.config;
    const diff = computeDiff(originalConfig, editedConfig) ?? {};

    await fetch(`/api/commands/task/${taskId}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config_diff: diff,
        reason: "User edit via config modal",
      }),
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
        body: JSON.stringify({
          name,
          task_class: taskClass,
          config: editedConfig,
        }),
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
    setEditedConfig((prev) => (prev ? { ...prev, gates } : prev));
  }, []);

  const updateRetryPolicy = useCallback((policy: RetryPolicy) => {
    setEditedConfig((prev) =>
      prev ? { ...prev, retry_policy: policy } : prev,
    );
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
            <span className="text-xs font-medium text-text-secondary">
              Configure task
            </span>
            <span className="text-xs text-text-tertiary font-mono">
              {detail.task_id}
            </span>
            <span className="text-sm font-semibold text-text-primary truncate">
              {detail.title}
            </span>
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
          <Select
            value={selectedPresetId ?? ""}
            onValueChange={(val) => {
              const id = val || undefined;
              setSelectedPresetId(id);
              const preset = presets.find((p) => p.preset_id === id);
              if (preset) {
                setEditedConfig(JSON.parse(JSON.stringify(preset.config)));
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">— none —</SelectItem>
              {presets.map((p) => (
                <SelectItem key={p.preset_id} value={p.preset_id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

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
            {/* PHASE PIPELINE — horizontal cards with arrows */}
            <section>
              <SectionHeader title="Phase pipeline" />
              <p className="text-[11px] text-muted-foreground -mt-2 mb-6 max-w-[130ch]">
                Each task runs through a sequence of phases from left to right.
                A phase is a single agent invocation.
              </p>
              <div className="flex items-stretch gap-0">
                {editedConfig.phases.map((phase, i) => (
                  <div
                    key={phase.name}
                    className="flex items-stretch flex-1 min-w-0"
                  >
                    <PhaseCard
                      phase={phase}
                      index={i}
                      gateNames={editedConfig.gates.map((g) => g.name)}
                      onChange={updatePhase}
                    />
                    {i < editedConfig.phases.length - 1 && (
                      <div className="flex items-center px-3 text-text-tertiary shrink-0">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* GATES */}
            <section>
              <GatesTable
                gates={editedConfig.gates}
                libraryGates={libraryGates}
                onChange={updateGates}
              />
            </section>

            {/* RETRY POLICY */}
            <section>
              <RetryPolicySection
                policy={editedConfig.retry_policy}
                onChange={updateRetryPolicy}
              />
            </section>

            {/* AUTO-MERGE */}
            <section>
              <AutoMergeSection
                policy={editedConfig.auto_merge_policy ?? "off"}
                shadowMode={editedConfig.shadow_mode ?? false}
                onPolicyChange={(p) =>
                  setEditedConfig((prev) =>
                    prev ? { ...prev, auto_merge_policy: p } : prev,
                  )
                }
                onShadowModeChange={(v) =>
                  setEditedConfig((prev) =>
                    prev ? { ...prev, shadow_mode: v } : prev,
                  )
                }
              />
            </section>
          </div>
        )}
      </div>
    </>
  );
}
