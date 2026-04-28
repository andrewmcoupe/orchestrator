import { Fragment, useCallback, useState, useMemo, useEffect } from "react";
import { SlidersHorizontal, ClipboardList, Plus, X, Info } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { TaskDetailRow, TaskListRow } from "@shared/projections.js";
import type {
  TaskStatus,
  TaskConfig,
  PhaseConfig,
  GateConfig,
  AnyEvent,
  GateFailed,
} from "@shared/events.js";
import { canAddDependency } from "@shared/dependency.js";
import { topoSort } from "@shared/dependency.js";
import {
  useTaskTimelineQuery,
  usePropositionsQuery,
} from "../../hooks/useQueries.js";
import { useLatestAssistantMessage } from "../../store/eventStore.js";
import { MergeDialog } from "../review/MergeDialog.js";
import { Button, buttonVariants } from "@web/src/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@web/src/components/ui/popover";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@web/src/components/ui/tooltip";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@web/src/components/ui/dialog";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";

type TaskDetailPaneProps = {
  detail: TaskDetailRow;
  listRow?: TaskListRow;
  /** All tasks in the project — needed for the dependency picker. */
  allTasks?: TaskListRow[];
};

// ============================================================================
// Status pill styling
// ============================================================================

const STATUS_PILL: Record<TaskStatus, string> = {
  draft: "bg-bg-tertiary text-text-secondary",
  queued: "bg-bg-tertiary text-text-secondary",
  running: "bg-status-warning/15 text-status-warning",
  paused: "bg-status-muted/15 text-status-muted",
  awaiting_review: "bg-status-warning/15 text-status-warning",
  revising: "bg-status-warning/15 text-status-warning",
  // approved = human has signed off, awaiting merge action
  approved: "bg-purple-500/15 text-purple-400",
  // awaiting_merge = merge process in flight (gates running, squashing, etc.)
  awaiting_merge: "bg-purple-500/15 text-purple-400",
  merged: "bg-status-healthy/15 text-status-healthy",
  rejected: "bg-status-danger/15 text-status-danger",
  archived: "bg-bg-tertiary text-text-tertiary",
  blocked: "bg-status-danger/15 text-status-danger",
};

// ============================================================================
// Phase box — shows model + prompt version + live status
// ============================================================================

type PhaseStatus = "done" | "running" | "pending";

function derivePhaseStatus(
  phase: PhaseConfig,
  enabledPhases: PhaseConfig[],
  currentPhase?: string,
  taskStatus?: TaskStatus,
  completedPhases?: string[],
): PhaseStatus {
  if (!taskStatus || taskStatus === "draft" || taskStatus === "queued")
    return "pending";
  // Terminal states — all phases are done
  if (
    taskStatus === "merged" ||
    taskStatus === "awaiting_review" ||
    taskStatus === "approved" ||
    taskStatus === "rejected" ||
    taskStatus === "awaiting_merge" ||
    taskStatus === "archived"
  )
    return "done";
  // Explicitly completed phases are always done
  if (completedPhases?.includes(phase.name)) return "done";
  if (currentPhase === phase.name) return "running";
  // If the task is active, phases before the current one are done
  if (
    (taskStatus === "running" ||
      taskStatus === "revising" ||
      taskStatus === "paused" ||
      taskStatus === "blocked") &&
    currentPhase
  ) {
    const currentIdx = enabledPhases.findIndex((p) => p.name === currentPhase);
    const thisIdx = enabledPhases.findIndex((p) => p.name === phase.name);
    if (currentIdx >= 0 && thisIdx >= 0 && thisIdx < currentIdx) return "done";
  }
  return "pending";
}

const PHASE_STATUS_STYLES: Record<PhaseStatus, string> = {
  done: "border-status-healthy/40 bg-status-healthy/5",
  running: "border-status-warning/40 bg-status-warning/5",
  pending: "border-border-muted bg-bg-secondary",
};

const PHASE_DOT: Record<PhaseStatus, string> = {
  done: "bg-status-healthy",
  running: "bg-status-warning",
  pending: "bg-status-muted",
};

function AssistantMessagePreview({ text }: { text: string }) {
  const truncated = text.length > 120 ? `${text.slice(0, 120)}…` : text;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <p
            key={text}
            className="text-start text-xs text-text-secondary mt-1.5 leading-relaxed line-clamp-2 animate-fade-in cursor-default"
          >
            {truncated}
          </p>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          className="max-w-sm max-h-60 overflow-y-auto whitespace-pre-wrap break-words"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PhaseBox({
  phase,
  enabledPhases,
  currentPhase,
  taskStatus,
  completedPhases,
  latestAssistantMessage,
}: {
  phase: PhaseConfig;
  enabledPhases: PhaseConfig[];
  currentPhase?: string;
  taskStatus?: TaskStatus;
  completedPhases?: string[];
  latestAssistantMessage?: string;
}) {
  const status = derivePhaseStatus(
    phase,
    enabledPhases,
    currentPhase,
    taskStatus,
    completedPhases,
  );
  const model = phase.model.split("/").pop() ?? phase.model;

  return (
    <div
      className={`border px-4 py-3 min-w-[140px] ${PHASE_STATUS_STYLES[status]}`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        {status === "running" ? (
          <span className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-status-warning border-t-transparent animate-spin" />
        ) : (
          <span
            className={`inline-block h-2 w-2 rounded-full ${PHASE_DOT[status]}`}
          />
        )}
        <span className="text-sm font-medium text-text-primary">
          {phase.name}
        </span>
      </div>
      <div className="text-xs text-text-secondary font-mono space-y-0.5">
        <div>
          <span className="text-text-tertiary">model:</span> {model}
        </div>
        <div>
          <span className="text-text-tertiary">prompt:</span>{" "}
          {phase.prompt_version_id || "v?"}
        </div>
      </div>
      {status === "running" && phase.name === "auditor" && (
        <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">
          Auditing the implementers changes against the acceptance criteria...
        </p>
      )}
      {status === "running" &&
        phase.name !== "auditor" &&
        latestAssistantMessage && (
          <AssistantMessagePreview text={latestAssistantMessage} />
        )}
      {status === "done" && (
        <span className="text-xs text-text-tertiary mt-1">Finished</span>
      )}
    </div>
  );
}

// ============================================================================
// Gate pill
// ============================================================================

function GatePill({ gate }: { gate: GateConfig }) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-border-default bg-bg-secondary px-2.5 py-1 text-xs">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-muted" />
      <span className="text-text-primary">{gate.name}</span>
    </span>
  );
}

// ============================================================================
// Action buttons
// ============================================================================

const ACTIONS_BY_STATUS: Record<
  string,
  { label: string; action: string; destructive?: boolean }[]
> = {
  draft: [
    { label: "Start", action: "start" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  queued: [
    { label: "Start", action: "start" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  running: [
    { label: "Pause", action: "pause" },
    { label: "Retry", action: "retry" },
    { label: "Kill", action: "kill" },
  ],
  paused: [
    { label: "Resume", action: "start" },
    { label: "Kill", action: "kill" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  awaiting_review: [
    { label: "Approve", action: "approve" },
    { label: "Reject", action: "reject" },
    { label: "Retry", action: "retry" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  approved: [
    { label: "Merge", action: "merge" },
    { label: "Unapprove", action: "unapprove" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  rejected: [
    { label: "Retry", action: "retry" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  merged: [{ label: "Archive", action: "archive", destructive: true }],
  revising: [
    { label: "Pause", action: "pause" },
    { label: "Kill", action: "kill" },
  ],
};

function ActionButtons({
  taskId,
  attemptId,
  status,
  onMerge,
  onStart,
}: {
  taskId: string;
  attemptId?: string;
  status: TaskStatus;
  onMerge?: () => void;
  onStart?: () => void;
}) {
  const actions = ACTIONS_BY_STATUS[status] ?? [];

  const handleAction = useCallback(
    async (action: string) => {
      // Merge opens the confirm dialog instead of firing directly
      if (action === "merge") {
        onMerge?.();
        return;
      }

      // Start opens the confirmation dialog
      if (action === "start") {
        onStart?.();
        return;
      }

      const base = "/api/commands";
      let url: string;
      let body: Record<string, unknown> = {};

      switch (action) {
        case "start":
          url = `${base}/task/${taskId}/start`;
          break;
        case "pause":
          url = `${base}/task/${taskId}/pause`;
          break;
        case "kill":
          url = `${base}/task/${taskId}/kill`;
          break;
        case "retry":
          url = `${base}/task/${taskId}/retry`;
          break;
        case "approve":
          if (!attemptId) return;
          url = `${base}/attempt/${attemptId}/approve`;
          body = { rationale: "Manual approval" };
          break;
        case "reject":
          if (!attemptId) return;
          url = `${base}/attempt/${attemptId}/reject`;
          body = { rationale: "Manual rejection" };
          break;
        case "unapprove":
          if (!attemptId) return;
          url = `${base}/attempt/${attemptId}/unapprove`;
          break;
        case "archive":
          url = `${base}/task/${taskId}/archive`;
          break;
        default:
          return;
      }

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    [taskId, attemptId, onMerge, onStart],
  );

  if (actions.length === 0) return null;

  return (
    <div className="flex gap-2">
      {actions.map((a) => (
        <Button
          key={a.action}
          type="button"
          onClick={() => handleAction(a.action)}
          variant={a.destructive ? "destructive" : "outline"}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}

// ============================================================================
// Dependency editing section
// ============================================================================

function DependencySection({
  taskId,
  status,
  dependsOn,
  allTasks,
}: {
  taskId: string;
  status: TaskStatus;
  dependsOn: string[];
  allTasks: TaskListRow[];
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const editable = canAddDependency(status);

  // Compute which tasks can be added as dependencies (no cycles, not self, not already a dep)
  const availableTasks = useMemo(() => {
    if (!editable || !pickerOpen) return [];
    const existing = new Set(dependsOn);
    return allTasks.filter((t) => {
      if (t.task_id === taskId || existing.has(t.task_id)) return false;
      // Check if adding this dependency would create a cycle
      const proposedGraph = allTasks.map((at) => ({
        id: at.task_id,
        depends_on:
          at.task_id === taskId
            ? [...dependsOn, t.task_id]
            : (at.depends_on ?? []),
      }));
      const result = topoSort(proposedGraph);
      return result.stripped.length === 0;
    });
  }, [editable, pickerOpen, allTasks, taskId, dependsOn]);

  const postDeps = useCallback(
    (newDeps: string[]) => {
      void fetch(`/api/commands/task/${taskId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depends_on: newDeps }),
      });
    },
    [taskId],
  );

  const handleAdd = useCallback(
    (depId: string) => {
      const newDeps = [...dependsOn, depId];
      postDeps(newDeps);
      setPickerOpen(false);
    },
    [dependsOn, postDeps],
  );

  const handleRemove = useCallback(
    (depId: string) => {
      const newDeps = dependsOn.filter((d) => d !== depId);
      postDeps(newDeps);
    },
    [dependsOn, postDeps],
  );

  // Don't render at all if no deps and not editable
  if (dependsOn.length === 0 && !editable) return null;

  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary">
          Dependencies
        </h3>
        {editable && (
          <button
            type="button"
            aria-label="Add dependency"
            onClick={() => setPickerOpen((v) => !v)}
            className="p-0.5 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {/* Current dependencies */}
      {dependsOn.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {dependsOn.map((depId) => (
            <span
              key={depId}
              className="inline-flex items-center gap-1 border border-border-default bg-bg-secondary px-2 py-1 text-xs font-mono"
            >
              {depId}
              {editable && (
                <button
                  type="button"
                  aria-label={`Remove dependency ${depId}`}
                  onClick={() => handleRemove(depId)}
                  className="p-0.5 text-text-tertiary hover:text-status-danger transition-colors"
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {dependsOn.length === 0 && !pickerOpen && (
        <p className="text-xs text-text-tertiary">No dependencies.</p>
      )}

      {/* Picker dropdown */}
      {pickerOpen && (
        <div className="border border-border-default bg-bg-secondary max-h-40 overflow-y-auto">
          {availableTasks.length === 0 ? (
            <p className="text-xs text-text-tertiary p-2">
              No tasks available to add.
            </p>
          ) : (
            availableTasks.map((t) => (
              <button
                key={t.task_id}
                type="button"
                onClick={() => handleAdd(t.task_id)}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary transition-colors flex items-center gap-2"
              >
                <span className="font-mono text-text-secondary">
                  {t.task_id}
                </span>
                <span className="text-text-primary truncate">{t.title}</span>
              </button>
            ))
          )}
        </div>
      )}
    </section>
  );
}

// ============================================================================
// Acceptance criteria — fetches proposition texts by ID
// ============================================================================

function AcceptanceCriteriaSection({
  propositionIds,
}: {
  propositionIds: string[];
}) {
  const { data: propositions, isLoading } =
    usePropositionsQuery(propositionIds);

  return (
    <section className="mb-6 text-xs">
      <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
        Acceptance criteria
      </h3>
      {isLoading ? (
        <p className="text-xs text-text-tertiary">Loading…</p>
      ) : propositions && propositions.length > 0 ? (
        <ol className="list-decimal list-inside space-y-1.5 border border-border-muted bg-bg-secondary p-4">
          {propositions.map((p) => (
            <li
              key={p.proposition_id}
              className=" text-text-primary leading-relaxed"
            >
              {p.text}
            </li>
          ))}
        </ol>
      ) : (
        <div className="border border-border-muted bg-bg-secondary p-4">
          <p className="text-xs text-text-tertiary font-mono">
            {propositionIds.join(" ")}
          </p>
        </div>
      )}
    </section>
  );
}

// ============================================================================
// Main component
// ============================================================================

// ============================================================================
// Task preview popover — shows what the task will have before implementation
// ============================================================================

function PromptPreview({ promptVersionId }: { promptVersionId: string }) {
  const [template, setTemplate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch(
      `/api/projections/prompt_template/${encodeURIComponent(promptVersionId)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { template: string } | null) => {
        setTemplate(data?.template ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [promptVersionId]);

  if (loading) {
    return <span className="text-[10px] text-text-tertiary">loading…</span>;
  }
  if (!template) {
    return (
      <span className="text-[10px] text-text-tertiary">template not found</span>
    );
  }

  const preview = template.slice(0, 200);
  const truncated = template.length > 200;

  return (
    <div className="mt-1.5">
      <pre className="text-[10px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words bg-bg-primary border border-border-muted p-2 max-h-48 overflow-y-auto">
        {expanded ? template : preview}
        {truncated && !expanded && "…"}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-text-tertiary hover:text-text-secondary mt-1 cursor-pointer"
        >
          {expanded
            ? "show less"
            : `show all (${template.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

type TaskPreviewConfig = Pick<TaskConfig, "phases" | "gates">;

function TaskPreviewPanel({
  config,
  propositionIds,
}: {
  config: TaskPreviewConfig;
  propositionIds: string[];
}) {
  const enabledPhases = config.phases.filter((p) => p.enabled);

  return (
    <div className="space-y-4">
      {/* Phases overview */}
      <div>
        <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
          Phases
        </h4>
        <div className="space-y-3">
          {enabledPhases.map((phase) => (
            <div
              key={phase.name}
              className="border border-border-muted bg-bg-secondary p-2.5"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-text-primary">
                  {phase.name}
                </span>
                <span className="text-[10px] font-mono text-text-tertiary">
                  {phase.transport} · {phase.model}
                </span>
              </div>

              {/* Prompt template */}
              {phase.prompt_version_id && (
                <div>
                  <span className="text-[10px] text-text-tertiary">
                    prompt: {phase.prompt_version_id}
                  </span>
                  <PromptPreview promptVersionId={phase.prompt_version_id} />
                </div>
              )}

              {/* Context policy */}
              <div className="mt-1.5 pt-1.5 border-t border-border-muted text-[11px] text-text-tertiary">
                <span className="text-text-secondary">context:</span> depth{" "}
                {phase.context_policy.symbol_graph_depth},{" "}
                {phase.context_policy.token_budget.toLocaleString()} tokens
                {phase.context_policy.include_tests && ", +tests"}
                {phase.context_policy.include_similar_patterns && ", +patterns"}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Gates */}
      {config.gates.length > 0 && (
        <div>
          <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
            Gates
          </h4>
          <div className="space-y-1">
            {config.gates.map((gate) => (
              <div
                key={gate.name}
                className="text-[11px] px-2 py-1 bg-bg-secondary border border-border-muted"
              >
                <span className="font-mono text-text-primary">{gate.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Propositions */}
      {propositionIds.length > 0 && (
        <div>
          <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
            Propositions ({propositionIds.length})
          </h4>
          <div className="space-y-1">
            {propositionIds.map((id) => (
              <div
                key={id}
                className="text-[11px] font-mono text-text-secondary px-2 py-1 bg-bg-secondary border border-border-muted truncate"
              >
                {id}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Start confirmation dialog
// ============================================================================

function StartConfirmDialog({
  taskId,
  taskTitle,
  config,
  propositionIds,
  open,
  onOpenChange,
}: {
  taskId: string;
  taskTitle: string;
  config: TaskConfig;
  propositionIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [starting, setStarting] = useState(false);

  const handleConfirm = useCallback(async () => {
    setStarting(true);
    await fetch(`/api/commands/task/${taskId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setStarting(false);
    onOpenChange(false);
  }, [taskId, onOpenChange]);

  const enabledPhases = config.phases.filter((p) => p.enabled);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Start task</DialogTitle>
          <DialogDescription>
            Review the configuration for{" "}
            <span className="font-medium text-foreground">{taskTitle}</span>{" "}
            <span className="font-mono text-[10px]">({taskId})</span> before
            starting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Phases */}
          <div>
            <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
              Phases ({enabledPhases.length})
            </h4>
            <div className="space-y-2">
              {enabledPhases.map((phase) => (
                <div
                  key={phase.name}
                  className="border border-border-muted bg-bg-secondary p-2.5"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-text-primary">
                      {phase.name}
                    </span>
                    <span className="text-[10px] font-mono text-text-tertiary">
                      {phase.transport} · {phase.model}
                    </span>
                  </div>
                  {phase.transport_options.kind === "cli" && (
                    <div className="text-[10px] text-text-tertiary">
                      max turns: {phase.transport_options.max_turns ?? "∞"} ·
                      budget: ${phase.transport_options.max_budget_usd ?? "∞"} ·
                      permission:{" "}
                      {phase.transport_options.permission_mode ?? "default"}
                    </div>
                  )}
                  {phase.transport_options.kind === "api" && (
                    <div className="text-[10px] text-text-tertiary">
                      max tokens: {phase.transport_options.max_tokens}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Gates */}
          {config.gates.length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
                Gates ({config.gates.length})
              </h4>
              <div className="space-y-1">
                {config.gates.map((gate) => (
                  <div
                    key={gate.name}
                    className="flex items-center justify-between text-[11px] px-2 py-1 bg-bg-secondary border border-border-muted"
                  >
                    <span className="font-mono text-text-primary">
                      {gate.name}
                    </span>
                    <span className="text-text-tertiary">
                      {gate.required ? "required" : "optional"} ·{" "}
                      {gate.timeout_seconds}s · on fail: {gate.on_fail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Retry policy */}
          <div>
            <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
              Retry policy
            </h4>
            <div className="text-[11px] text-text-secondary px-2 py-1.5 bg-bg-secondary border border-border-muted">
              Max attempts: {config.retry_policy.max_total_attempts}
              {config.auto_merge_policy &&
                config.auto_merge_policy !== "off" && (
                  <span>
                    {" "}
                    · auto-merge: {config.auto_merge_policy.replace(/_/g, " ")}
                  </span>
                )}
              {config.shadow_mode && <span> · shadow mode</span>}
            </div>
          </div>

          {/* Propositions */}
          {propositionIds.length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
                Propositions ({propositionIds.length})
              </h4>
              <div className="space-y-1">
                {propositionIds.map((id) => (
                  <div
                    key={id}
                    className="text-[11px] font-mono text-text-secondary px-2 py-1 bg-bg-secondary border border-border-muted truncate"
                  >
                    {id}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button onClick={handleConfirm} disabled={starting}>
            {starting ? "Starting…" : "Confirm & start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Main component
// ============================================================================

export function TaskDetailPane({
  detail,
  listRow,
  allTasks,
}: TaskDetailPaneProps) {
  const enabledPhases = detail.config.phases.filter((p) => p.enabled);
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [showStartDialog, setShowStartDialog] = useState(false);
  const latestAssistantMessage = useLatestAssistantMessage(
    listRow?.current_attempt_id ?? undefined,
  );

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Action toolbar */}
      <div className="sticky top-0 bg-background z-10 flex items-center justify-between px-6 py-2.5 border-b border-border-muted bg-bg-secondary shrink-0">
        <div className="flex items-center gap-2">
          {detail.status !== "merged" &&
            detail.status !== "archived" && (
              <Link
                to="/tasks/$taskId/config"
                params={{ taskId: detail.task_id }}
                className={buttonVariants({ variant: "outline" })}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Config
              </Link>
            )}
          {detail.current_attempt_id &&
            (detail.status === "awaiting_review" ? (
              <Link
                to="/tasks/$taskId/review/$attemptId"
                params={{
                  taskId: detail.task_id,
                  attemptId: detail.current_attempt_id!,
                }}
                className={buttonVariants()}
              >
                <ClipboardList className="h-3.5 w-3.5" />
                Review
              </Link>
            ) : detail.status === "approved" ? (
              <Link
                to="/tasks/$taskId/review/$attemptId"
                params={{
                  taskId: detail.task_id,
                  attemptId: detail.current_attempt_id!,
                }}
                title="Review changes from last attempt"
                className={buttonVariants()}
              >
                <ClipboardList className="h-3.5 w-3.5" />
                Review changes
              </Link>
            ) : detail.status === "merged" || detail.status === "rejected" ? (
              <Link
                to="/tasks/$taskId/review/$attemptId"
                params={{
                  taskId: detail.task_id,
                  attemptId: detail.current_attempt_id!,
                }}
                title="View diff from last attempt"
                className={buttonVariants()}
              >
                <ClipboardList className="h-3.5 w-3.5" />
                View diff
              </Link>
            ) : null)}
        </div>
        <ActionButtons
          taskId={detail.task_id}
          attemptId={detail.current_attempt_id ?? undefined}
          status={detail.status}
          onMerge={() => setShowMergeDialog(true)}
          onStart={() => setShowStartDialog(true)}
        />
      </div>

      {/* Task identity */}
      <div className="px-6 pt-5 pb-6">
        <div className="flex items-center gap-3 mb-1">
          <span className="font-mono text-sm text-text-secondary">
            {detail.task_id}
          </span>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILL[detail.status]}`}
          >
            {detail.status}
          </span>
          {detail.worktree_branch && (
            <span className="text-xs text-text-tertiary font-mono">
              worktree: {detail.worktree_branch}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold text-text-primary">
            {detail.title}
          </h2>
          <Popover>
            <PopoverTrigger
              aria-label="Show task configuration preview"
              className="p-1 text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
            >
              <Info size={16} />
            </PopoverTrigger>
            <PopoverContent
              className="w-96 max-h-[70vh] overflow-y-auto"
              side="bottom"
              align="start"
            >
              <TaskPreviewPanel
                config={{
                  phases: detail.config.phases,
                  gates: detail.config.gates,
                }}
                propositionIds={detail.proposition_ids}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Start confirmation dialog */}
      <StartConfirmDialog
        taskId={detail.task_id}
        taskTitle={detail.title}
        config={detail.config}
        propositionIds={detail.proposition_ids}
        open={showStartDialog}
        onOpenChange={setShowStartDialog}
      />

      {/* Merge confirmation dialog */}
      {showMergeDialog && (
        <MergeDialog
          taskId={detail.task_id}
          taskTitle={detail.title}
          currentBranch={detail.worktree_branch ?? null}
          priorGateRuns={[]}
          onClose={() => setShowMergeDialog(false)}
          onSuccess={() => setShowMergeDialog(false)}
        />
      )}

      {/* Pause banner */}
      {detail.status === "paused" && (
        <div className="mx-6 mt-4 px-3 py-2 border border-status-muted/30 bg-status-muted/5 text-xs text-text-secondary">
          Pausing after current phase completes. Events may continue until then.
        </div>
      )}

      {/* Content sections */}
      <div className="px-6 pb-6">
        {/* Dependency editing */}
        {allTasks && (
          <DependencySection
            taskId={detail.task_id}
            status={detail.status}
            dependsOn={listRow?.depends_on ?? []}
            allTasks={allTasks}
          />
        )}

        {/* Phase pipeline */}
        <section className="mb-6">
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
            Phases
          </h3>
          <div
            className="grid items-stretch gap-3"
            style={{
              gridTemplateColumns: enabledPhases
                .map((_, i) => (i > 0 ? "auto 1fr" : "1fr"))
                .join(" "),
            }}
          >
            {enabledPhases.map((phase, i) => (
              <Fragment key={phase.name}>
                {i > 0 && (
                  <ArrowRightIcon
                    size={14}
                    className="text-text-tertiary self-center"
                  />
                )}
                <PhaseBox
                  phase={phase}
                  enabledPhases={enabledPhases}
                  currentPhase={listRow?.current_phase ?? undefined}
                  taskStatus={detail.status}
                  completedPhases={listRow?.completed_phases}
                  latestAssistantMessage={latestAssistantMessage}
                />
              </Fragment>
            ))}
            {enabledPhases.length === 0 && (
              <p className="text-sm text-text-tertiary">
                No phases configured.
              </p>
            )}
          </div>
        </section>

        {/* Gates */}
        {detail.config.gates.length > 0 && (
          <section className="mb-6">
            <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">
              Gates
            </h3>
            <div className="flex flex-wrap gap-2">
              {detail.config.gates.map((gate) => (
                <GatePill key={gate.name} gate={gate} />
              ))}
            </div>
          </section>
        )}

        {/* Acceptance criteria */}
        {detail.proposition_ids.length > 0 && (
          <AcceptanceCriteriaSection propositionIds={detail.proposition_ids} />
        )}

        {/* Task timeline */}
        <TaskTimeline taskId={detail.task_id} status={detail.status} />
      </div>
    </div>
  );
}

// ============================================================================
// Task timeline
// ============================================================================

function timelineColor(event: AnyEvent): string {
  const type = event.type;
  const payload = event.payload as unknown as Record<string, unknown>;
  if (
    type.includes("approved") ||
    type.includes("passed") ||
    type === "attempt.completed"
  ) {
    if (payload.outcome === "no_changes") return "bg-status-muted";
    return "bg-status-healthy";
  }
  if (
    type.includes("failed") ||
    type.includes("rejected") ||
    type.includes("killed")
  )
    return "bg-status-danger";
  if (
    type.includes("started") ||
    type.includes("running") ||
    type.includes("phase.")
  )
    return "bg-status-warning";
  return "bg-status-muted";
}

function timelineDetail(event: AnyEvent): string {
  const p = event.payload as unknown as Record<string, unknown>;
  if (p.from && p.to) return `${p.from} → ${p.to}`;
  if (p.phase_name) return String(p.phase_name);
  if (p.outcome === "no_changes") return "no changes — skipped review";
  if (p.outcome) return String(p.outcome);
  if (p.gate_name) return String(p.gate_name);
  if (p.verdict) return `verdict: ${p.verdict}`;
  if (p.title) return String(p.title);
  if (p.reason) return String(p.reason);
  return "";
}

function formatTimelineTs(ts: string): string {
  return new Date(ts).toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function TaskTimeline({
  taskId,
  status,
}: {
  taskId: string;
  status?: TaskStatus;
}) {
  const { data: events, isLoading } = useTaskTimelineQuery(taskId, status);

  if (isLoading) {
    return (
      <section className="mt-6">
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-3">
          Timeline
        </h3>
        <p className="text-xs text-text-tertiary">Loading…</p>
      </section>
    );
  }

  if (events.length === 0) return null;

  return (
    <section className="mt-6">
      <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-3">
        Timeline
      </h3>
      <div className="relative pl-4 border-l border-border-muted">
        {[...events].reverse().map((event) => {
          const detail = timelineDetail(event);
          const gateFailures =
            event.type === "gate.failed"
              ? (event.payload as GateFailed).failures
              : undefined;
          return (
            <div key={event.id} className="relative py-1.5">
              <div
                className={`absolute -left-[calc(1rem+3px)] top-2.5 h-1.5 w-1.5 rounded-full ${timelineColor(event)}`}
              />
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-[10px] text-text-tertiary w-32 shrink-0 font-mono">
                  {formatTimelineTs(event.ts)}
                </span>
                <span className="text-xs font-mono font-medium text-text-primary truncate">
                  {event.type}
                </span>
                {detail && (
                  <span className="text-xs text-text-secondary truncate">
                    {detail}
                  </span>
                )}
              </div>
              {gateFailures && gateFailures.length > 0 && (
                <div className="mt-1.5 ml-32 space-y-1">
                  {gateFailures.map((f, i) => (
                    <div
                      key={i}
                      className="border border-status-danger/20 bg-status-danger/5 px-3 py-1.5 text-xs"
                    >
                      {f.location && (
                        <span className="font-mono text-text-secondary">
                          {f.location.path}:{f.location.line}
                          {f.location.col != null ? `:${f.location.col}` : ""}
                          {" — "}
                        </span>
                      )}
                      <span className="text-text-primary">{f.excerpt}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
