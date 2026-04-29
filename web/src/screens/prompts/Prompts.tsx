/**
 * Prompts section — prompt version library, version history, and A/B experiments.
 *
 * Layout:
 *   - Left panel: grouped by phase_class, each showing prompt versions
 *   - Right panel: detail view for selected prompt (template, history, diff)
 *   - Top: tabs for Library / A/B Experiments
 *   - Actions: New version (fork), Start A/B, Retire
 */

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch,
  FlaskConical,
  Archive,
  CheckCircle,
  AlertCircle,
  Clock,
} from "lucide-react";
import type { PromptVersionRow, AbExperimentRow } from "@shared/projections.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "../../components/ui/dialog.js";
import { Button } from "../../components/ui/button.js";

// ============================================================================
// Types
// ============================================================================

type Tab = "library" | "experiments";

// ============================================================================
// Hooks
// ============================================================================

function usePromptLibrary(): {
  rows: PromptVersionRow[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [rows, setRows] = useState<PromptVersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projections/prompt_library");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetch_();
  }, []);
  return { rows, loading, error, refetch: fetch_ };
}

function useAbExperiments(): {
  rows: AbExperimentRow[];
  loading: boolean;
  refetch: () => void;
} {
  const [rows, setRows] = useState<AbExperimentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch_ = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projections/ab_experiment");
      if (!res.ok) throw new Error();
      setRows(await res.json());
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetch_();
  }, []);
  return { rows, loading, refetch: fetch_ };
}

// ============================================================================
// Sub-components
// ============================================================================

function StatusBadge({ retired }: { retired: boolean }) {
  if (retired) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-red-500/10 text-red-400 border border-red-500/20">
        <Archive size={10} />
        retired
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-green-500/10 text-green-400 border border-green-500/20">
      <CheckCircle size={10} />
      active
    </span>
  );
}

function ExperimentBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20">
      <FlaskConical size={10} />
      {count} A/B
    </span>
  );
}

function StatsBar({ row }: { row: PromptVersionRow }) {
  return (
    <div className="flex items-center gap-4 text-xs text-text-tertiary">
      <span className="flex items-center gap-1">
        <Clock size={10} />
        {row.invocations_last_30d} runs
      </span>
      {row.success_rate_last_30d !== undefined && (
        <span
          className={
            row.success_rate_last_30d >= 0.8
              ? "text-healthy"
              : row.success_rate_last_30d >= 0.5
                ? "text-warning"
                : "text-danger"
          }
        >
          {Math.round(row.success_rate_last_30d * 100)}% success
        </span>
      )}
      {row.avg_cost_usd !== undefined && (
        <span>${row.avg_cost_usd.toFixed(4)}/run</span>
      )}
    </div>
  );
}

interface PromptRowItemProps {
  row: PromptVersionRow;
  selected: boolean;
  onClick: () => void;
}

function PromptRowItem({ row, selected, onClick }: PromptRowItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full text-left px-3 py-2.5 border transition-colors",
        selected
          ? "border-amber-500/50 bg-amber-500/5"
          : "border-transparent hover:border-white/10 hover:bg-white/5",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-sm font-medium text-text-primary truncate">{row.name}</span>
        <div className="flex items-center gap-1 shrink-0">
          <ExperimentBadge count={row.ab_experiment_ids.length} />
          <StatusBadge retired={row.retired} />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <code className="text-xs text-text-tertiary font-mono">{row.template_hash.slice(0, 8)}</code>
        {row.parent_version_id && (
          <span className="flex items-center gap-1 text-xs text-text-tertiary">
            <GitBranch size={9} />
            forked
          </span>
        )}
      </div>
      <StatsBar row={row} />
    </button>
  );
}

interface TemplateViewerProps {
  templateHash: string;
  promptVersionId: string;
}

function TemplateViewer({ templateHash, promptVersionId }: TemplateViewerProps) {
  // Try blob store first, fall back to event payload
  const blobQuery = useQuery({
    queryKey: ["blob", templateHash],
    queryFn: async () => {
      const res = await fetch(`/api/blobs/${templateHash}`);
      if (!res.ok) throw new Error("blob not found");
      return res.text();
    },
    staleTime: Infinity,
    retry: false,
  });

  const fallbackQuery = useQuery({
    queryKey: ["prompt_template", promptVersionId],
    queryFn: async () => {
      const res = await fetch(`/api/projections/prompt_template/${promptVersionId}`);
      if (!res.ok) throw new Error("template not found");
      return (await res.json() as { template: string }).template;
    },
    enabled: blobQuery.isError,
    staleTime: Infinity,
  });

  const content = blobQuery.data ?? fallbackQuery.data;
  const loading = blobQuery.isLoading || (blobQuery.isError && fallbackQuery.isLoading);

  if (loading)
    return <div className="text-xs text-text-tertiary p-4">Loading template…</div>;
  if (!content)
    return (
      <div className="text-xs text-warning p-4">Template not found.</div>
    );

  return (
    <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap p-4 bg-surface-secondary border border-white/5 overflow-auto max-h-96">
      {content}
    </pre>
  );
}

interface NewVersionModalProps {
  parent: PromptVersionRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

function NewVersionModal({ parent, open, onOpenChange, onCreated }: NewVersionModalProps) {
  const [template, setTemplate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Pre-fill with parent template as a starting point
    if (open) {
      fetch(`/api/blobs/${parent.template_hash}`)
        .then((r) => (r.ok ? r.text() : ""))
        .then(setTemplate)
        .catch(() => {});
    }
  }, [parent.template_hash, open]);

  const handleSave = async () => {
    if (!template.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/commands/prompt_version/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${parent.name} v2`,
          phase_class: parent.phase_class,
          template,
          parent_version_id: parent.prompt_version_id,
          notes: notes || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      onCreated();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New version</DialogTitle>
          <DialogDescription>
            Fork of <code className="font-mono">{parent.name}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Template</label>
            <textarea
              className="w-full h-64 text-xs font-mono bg-muted border border-border p-3 text-foreground resize-none focus:outline-none focus:border-ring"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="Edit the prompt template…"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Notes (optional)
            </label>
            <input
              type="text"
              className="w-full text-xs bg-muted border border-border px-3 py-2 text-foreground focus:outline-none focus:border-ring"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What changed?"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            onClick={handleSave}
            disabled={saving || !template.trim()}
          >
            {saving ? "Saving…" : "Create version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface StartAbModalProps {
  promptA: PromptVersionRow;
  allPrompts: PromptVersionRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

function StartAbModal({ promptA, allPrompts, open, onOpenChange, onCreated }: StartAbModalProps) {
  const candidates = allPrompts.filter(
    (p) =>
      p.prompt_version_id !== promptA.prompt_version_id &&
      p.phase_class === promptA.phase_class &&
      !p.retired,
  );
  const [variantBId, setVariantBId] = useState(
    candidates[0]?.prompt_version_id ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!variantBId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/commands/ab_experiment/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase_class: promptA.phase_class,
          variant_a_id: promptA.prompt_version_id,
          variant_b_id: variantBId,
          split: [50, 50],
          bucket_key: "${task_id}:${phase_name}",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      onCreated();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical size={14} /> Start A/B experiment
          </DialogTitle>
          <DialogDescription>
            Compare two prompt variants head-to-head with a 50/50 traffic split.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Variant A (selected)
            </label>
            <div className="text-xs text-foreground px-3 py-2 bg-muted border border-border">
              {promptA.name}{" "}
              <code className="text-muted-foreground font-mono ml-1">
                {promptA.template_hash.slice(0, 8)}
              </code>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Variant B</label>
            {candidates.length === 0 ? (
              <p className="text-xs text-destructive">
                No other active prompts for phase{" "}
                <strong>{promptA.phase_class}</strong>. Create another version
                first.
              </p>
            ) : (
              <select
                className="w-full text-xs bg-muted border border-border px-3 py-2 text-foreground focus:outline-none focus:border-ring"
                value={variantBId}
                onChange={(e) => setVariantBId(e.target.value)}
              >
                {candidates.map((p) => (
                  <option key={p.prompt_version_id} value={p.prompt_version_id}>
                    {p.name} ({p.template_hash.slice(0, 8)})
                  </option>
                ))}
              </select>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            onClick={handleCreate}
            disabled={saving || !variantBId || candidates.length === 0}
          >
            {saving ? "Creating…" : "Start experiment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DetailPaneProps {
  row: PromptVersionRow;
  allRows: PromptVersionRow[];
  onNewVersion: () => void;
  onStartAb: () => void;
  onRetire: () => void;
}

function DetailPane({ row, allRows, onNewVersion, onStartAb, onRetire }: DetailPaneProps) {
  // Build version history by walking the parent chain
  const history: PromptVersionRow[] = [row];
  let cur = row;
  while (cur.parent_version_id) {
    const parent = allRows.find((r) => r.prompt_version_id === cur.parent_version_id);
    if (!parent) break;
    history.push(parent);
    cur = parent;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto">
      {/* Header */}
      <div className="px-5 py-4 border-b border-white/5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{row.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-text-tertiary font-mono">{row.phase_class}</span>
              <span className="text-text-tertiary">·</span>
              <code className="text-xs text-text-tertiary font-mono">
                {row.template_hash.slice(0, 12)}
              </code>
              <StatusBadge retired={row.retired} />
            </div>
            {row.notes && (
              <p className="text-xs text-text-secondary mt-1">{row.notes}</p>
            )}
          </div>
          {!row.retired && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onNewVersion}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-white/10 text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors"
              >
                <GitBranch size={12} />
                New version
              </button>
              <button
                type="button"
                onClick={onStartAb}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition-colors"
              >
                <FlaskConical size={12} />
                Start A/B
              </button>
              <button
                type="button"
                onClick={onRetire}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-white/10 text-text-tertiary hover:bg-white/5 hover:text-danger transition-colors"
              >
                <Archive size={12} />
                Retire
              </button>
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-5 mt-3">
          <div className="text-center">
            <p className="text-xl font-semibold text-text-primary">
              {row.invocations_last_30d}
            </p>
            <p className="text-xs text-text-tertiary mt-0.5">runs</p>
          </div>
          {row.success_rate_last_30d !== undefined && (
            <div className="text-center">
              <p
                className={`text-xl font-semibold ${
                  row.success_rate_last_30d >= 0.8
                    ? "text-healthy"
                    : row.success_rate_last_30d >= 0.5
                      ? "text-warning"
                      : "text-danger"
                }`}
              >
                {Math.round(row.success_rate_last_30d * 100)}%
              </p>
              <p className="text-xs text-text-tertiary mt-0.5">success</p>
            </div>
          )}
          {row.avg_cost_usd !== undefined && (
            <div className="text-center">
              <p className="text-xl font-semibold text-text-primary">
                ${row.avg_cost_usd.toFixed(4)}
              </p>
              <p className="text-xs text-text-tertiary mt-0.5">avg cost</p>
            </div>
          )}
          {row.ab_experiment_ids.length > 0 && (
            <div className="text-center">
              <p className="text-xl font-semibold text-amber-400">
                {row.ab_experiment_ids.length}
              </p>
              <p className="text-xs text-text-tertiary mt-0.5">A/B tests</p>
            </div>
          )}
        </div>
      </div>

      {/* Template viewer */}
      <div className="px-5 py-4 border-b border-white/5">
        <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
          Template
        </h3>
        <TemplateViewer templateHash={row.template_hash} promptVersionId={row.prompt_version_id} />
      </div>

      {/* Version history */}
      {history.length > 1 && (
        <div className="px-5 py-4">
          <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
            Version history
          </h3>
          <div className="space-y-1">
            {history.map((h, i) => (
              <div key={h.prompt_version_id} className="flex items-center gap-2 text-xs">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${i === 0 ? "bg-amber-400" : "bg-white/20"}`}
                />
                <code className="text-text-tertiary font-mono">
                  {h.template_hash.slice(0, 8)}
                </code>
                <span className="text-text-secondary">{h.name}</span>
                {h.retired && <span className="text-danger/70">(retired)</span>}
                {i === 0 && (
                  <span className="text-text-tertiary/50">← current</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── A/B Experiments tab ──────────────────────────────────────────────────────

function ExperimentStatusPill({ status }: { status: "running" | "concluded" }) {
  return status === "running" ? (
    <span className="px-1.5 py-0.5 text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20">
      running
    </span>
  ) : (
    <span className="px-1.5 py-0.5 text-xs bg-white/5 text-text-tertiary border border-white/10">
      concluded
    </span>
  );
}

function WinnerBadge({ winner }: { winner?: "A" | "B" | "none" }) {
  if (!winner) return null;
  if (winner === "none")
    return <span className="text-xs text-text-tertiary">No winner</span>;
  return (
    <span className="px-1.5 py-0.5 text-xs bg-healthy/10 text-healthy border border-healthy/20">
      Variant {winner} won
    </span>
  );
}

interface AbExperimentCardProps {
  exp: AbExperimentRow;
  prompts: PromptVersionRow[];
  onConclude: (id: string) => void;
}

function AbExperimentCard({ exp, prompts, onConclude }: AbExperimentCardProps) {
  const variantA = prompts.find((p) => p.prompt_version_id === exp.variant_a_id);
  const variantB = prompts.find((p) => p.prompt_version_id === exp.variant_b_id);

  return (
    <div
      data-testid={`experiment-card-${exp.experiment_id}`}
      className="border border-white/10 p-4 space-y-3 hover:border-white/20 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical size={14} className="text-amber-400" />
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            {exp.phase_class}
          </span>
          <ExperimentStatusPill status={exp.status} />
        </div>
        <div className="flex items-center gap-2">
          <WinnerBadge winner={exp.winner} />
          {exp.status === "running" && (
            <button
              type="button"
              onClick={() => onConclude(exp.experiment_id)}
              className="text-xs px-2 py-1 border border-white/10 text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors"
            >
              Conclude
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Variant A */}
        <div className="bg-surface-secondary p-3 border border-white/5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-secondary">Variant A</span>
            <code className="text-xs text-text-tertiary font-mono">
              {exp.variant_a_id.slice(-6)}
            </code>
          </div>
          <p className="text-xs text-text-primary truncate mb-2">
            {variantA?.name ?? "Unknown"}
          </p>
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-text-tertiary">Runs</span>
              <span className="text-text-primary">{exp.a_n}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-tertiary">Success</span>
              <span
                className={
                  exp.a_success_rate >= exp.b_success_rate
                    ? "text-healthy"
                    : "text-text-primary"
                }
              >
                {Math.round(exp.a_success_rate * 100)}%
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-tertiary">Avg cost</span>
              <span className="text-text-primary">
                {exp.a_n > 0 ? `$${(exp.a_cost_usd / exp.a_n).toFixed(4)}` : "—"}
              </span>
            </div>
          </div>
          {exp.a_n > 0 && (
            <div className="mt-2">
              <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-healthy/50 rounded-full"
                  style={{ width: `${exp.a_success_rate * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Variant B */}
        <div className="bg-surface-secondary p-3 border border-white/5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-secondary">Variant B</span>
            <code className="text-xs text-text-tertiary font-mono">
              {exp.variant_b_id.slice(-6)}
            </code>
          </div>
          <p className="text-xs text-text-primary truncate mb-2">
            {variantB?.name ?? "Unknown"}
          </p>
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-text-tertiary">Runs</span>
              <span className="text-text-primary">{exp.b_n}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-tertiary">Success</span>
              <span
                className={
                  exp.b_success_rate > exp.a_success_rate
                    ? "text-healthy"
                    : "text-text-primary"
                }
              >
                {Math.round(exp.b_success_rate * 100)}%
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-tertiary">Avg cost</span>
              <span className="text-text-primary">
                {exp.b_n > 0 ? `$${(exp.b_cost_usd / exp.b_n).toFixed(4)}` : "—"}
              </span>
            </div>
          </div>
          {exp.b_n > 0 && (
            <div className="mt-2">
              <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-healthy/50 rounded-full"
                  style={{ width: `${exp.b_success_rate * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {exp.significance_p !== undefined && (
        <p className="text-xs text-text-tertiary">
          p-value:{" "}
          <span
            className={
              exp.significance_p < 0.05 ? "text-healthy" : "text-text-secondary"
            }
          >
            {exp.significance_p.toFixed(4)}
          </span>
          {exp.significance_p < 0.05 && (
            <span className="text-healthy ml-1">— statistically significant</span>
          )}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// ConcludeModal — inline, below main component to avoid hoisting issues
// ============================================================================

interface ConcludeModalProps {
  experimentId: string;
  onClose: () => void;
  onConcluded: () => void;
}

function ConcludeModal({ experimentId, onClose, onConcluded }: ConcludeModalProps) {
  const [winner, setWinner] = useState<"A" | "B" | "none">("none");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!reason.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/commands/ab_experiment/${experimentId}/conclude`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          winner,
          reason,
          stats: {
            a: { n: 0, success_rate: 0, avg_cost_usd: 0 },
            b: { n: 0, success_rate: 0, avg_cost_usd: 0 },
          },
        }),
      });
      if (res.ok) onConcluded();
    } catch {
      /* silent */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-primary border border-white/10 w-96 shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h3 className="text-sm font-semibold text-text-primary">
            Conclude experiment
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary text-xs px-2 py-1"
          >
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Winner</label>
            <select
              className="w-full text-xs bg-surface-secondary border border-white/10 px-3 py-2 text-text-primary focus:outline-none focus:border-amber-500/50"
              value={winner}
              onChange={(e) => setWinner(e.target.value as "A" | "B" | "none")}
            >
              <option value="none">No winner</option>
              <option value="A">Variant A</option>
              <option value="B">Variant B</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Reason</label>
            <input
              type="text"
              className="w-full text-xs bg-surface-secondary border border-white/10 px-3 py-2 text-text-primary focus:outline-none focus:border-amber-500/50"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you concluding this experiment?"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs border border-white/10 text-text-secondary hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || !reason.trim()}
            className="px-3 py-1.5 text-xs bg-amber-500 text-black font-medium hover:bg-amber-400 disabled:opacity-50"
          >
            {saving ? "Concluding…" : "Conclude"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Prompts component
// ============================================================================

export function Prompts() {
  const [tab, setTab] = useState<Tab>("library");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [showStartAb, setShowStartAb] = useState(false);
  const [concludingId, setConcludingId] = useState<string | null>(null);

  const { rows, loading, error, refetch } = usePromptLibrary();
  const {
    rows: experiments,
    loading: expLoading,
    refetch: refetchExp,
  } = useAbExperiments();

  // Live SSE updates: refetch experiments when experiment-related events arrive
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as { type: string };
        const liveEventTypes = new Set([
          "invocation.completed",
          "auditor.judged",
          "ab_experiment.created",
          "ab_experiment.concluded",
        ]);
        if (liveEventTypes.has(event.type)) {
          refetchExp();
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [refetchExp]);

  // Group prompt versions by phase_class for the sidebar
  const grouped = rows.reduce<Record<string, PromptVersionRow[]>>((acc, r) => {
    (acc[r.phase_class] ??= []).push(r);
    return acc;
  }, {});

  const selectedRow = rows.find((r) => r.prompt_version_id === selectedId);

  const handleRetire = async () => {
    if (!selectedId) return;
    const res = await fetch(`/api/commands/prompt_version/${selectedId}/retire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      refetch();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 pt-3 border-b border-white/5">
        {(["library", "experiments"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={[
              "px-3 py-2 text-xs font-medium  transition-colors capitalize",
              tab === t
                ? "text-text-primary border-b-2 border-amber-400 -mb-px"
                : "text-text-tertiary hover:text-text-secondary",
            ].join(" ")}
          >
            {t === "library"
              ? "Prompt Library"
              : `A/B Experiments${experiments.length ? ` (${experiments.length})` : ""}`}
          </button>
        ))}
      </div>

      {tab === "library" && (
        <div className="flex-1 flex min-h-0">
          {/* Left: version list grouped by phase */}
          <div className="w-72 shrink-0 border-r border-white/5 flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-white/5">
              <span className="text-xs text-text-tertiary uppercase tracking-wide">
                {rows.length} version{rows.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="flex-1 overflow-auto p-2 space-y-3">
              {loading && (
                <div className="text-xs text-text-tertiary p-3">Loading…</div>
              )}
              {error && <div className="text-xs text-danger p-3">{error}</div>}
              {!loading && rows.length === 0 && (
                <div className="text-xs text-text-tertiary p-3">
                  No prompt versions yet. Ingest a PRD or run the auditor to seed
                  prompts.
                </div>
              )}
              {Object.entries(grouped).map(([phase, phaseRows]) => (
                <div key={phase}>
                  <p className="px-1 mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
                    {phase}
                  </p>
                  <div className="space-y-1">
                    {phaseRows.map((r) => (
                      <PromptRowItem
                        key={r.prompt_version_id}
                        row={r}
                        selected={selectedId === r.prompt_version_id}
                        onClick={() => setSelectedId(r.prompt_version_id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: detail pane */}
          <div className="flex-1 flex flex-col min-h-0">
            {selectedRow ? (
              <DetailPane
                row={selectedRow}
                allRows={rows}
                onNewVersion={() => setShowNewVersion(true)}
                onStartAb={() => setShowStartAb(true)}
                onRetire={handleRetire}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-text-tertiary">
                <div className="text-center">
                  <AlertCircle size={32} className="mx-auto mb-2 opacity-30" />
                  <p>Select a prompt version to view details</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "experiments" && (
        <div className="flex-1 overflow-auto p-4">
          {expLoading && (
            <p className="text-xs text-text-tertiary">Loading…</p>
          )}
          {!expLoading && experiments.length === 0 && (
            <div className="text-center py-12 text-text-tertiary">
              <FlaskConical size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">No A/B experiments yet.</p>
              <p className="text-xs mt-1">
                Select a prompt in the library and click "Start A/B".
              </p>
            </div>
          )}

          {/* Running experiments */}
          {experiments.some((e) => e.status === "running") && (
            <section data-testid="running-section" className="mb-8">
              <h3 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3 flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                Running
              </h3>
              <div className="space-y-4 max-w-2xl">
                {experiments
                  .filter((e) => e.status === "running")
                  .map((exp) => (
                    <AbExperimentCard
                      key={exp.experiment_id}
                      exp={exp}
                      prompts={rows}
                      onConclude={(id) => setConcludingId(id)}
                    />
                  ))}
              </div>
            </section>
          )}

          {/* History — concluded experiments */}
          {experiments.some((e) => e.status === "concluded") && (
            <section data-testid="history-section">
              <h3 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
                History
              </h3>
              <div className="space-y-4 max-w-2xl">
                {experiments
                  .filter((e) => e.status === "concluded")
                  .map((exp) => (
                    <AbExperimentCard
                      key={exp.experiment_id}
                      exp={exp}
                      prompts={rows}
                      onConclude={(id) => setConcludingId(id)}
                    />
                  ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Modals */}
      {selectedRow && (
        <NewVersionModal
          parent={selectedRow}
          open={showNewVersion}
          onOpenChange={setShowNewVersion}
          onCreated={() => {
            refetch();
            refetchExp();
          }}
        />
      )}
      {selectedRow && (
        <StartAbModal
          promptA={selectedRow}
          allPrompts={rows}
          open={showStartAb}
          onOpenChange={setShowStartAb}
          onCreated={() => {
            refetch();
            refetchExp();
            setTab("experiments");
          }}
        />
      )}
      {concludingId && (
        <ConcludeModal
          experimentId={concludingId}
          onClose={() => setConcludingId(null)}
          onConcluded={() => {
            refetchExp();
            setConcludingId(null);
          }}
        />
      )}
    </div>
  );
}
