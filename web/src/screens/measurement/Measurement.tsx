/**
 * Measurement section — cost, invocations, tasks, A/B experiments, and top prompts.
 *
 * Data sources:
 *   /api/measurement/cost         — daily cost/token rollups
 *   /api/projections/ab_experiment — A/B experiment stats
 *   /api/projections/prompt_library — prompt usage stats
 *   /api/projections/task_list      — task status breakdown
 */

import { useState, useEffect, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { BarChart3, Zap, FlaskConical, FileText, GitMerge } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsPanel } from "@web/src/components/ui/tabs.js";
import type { CostRollupRow, AbExperimentRow, PromptVersionRow, TaskListRow } from "@shared/projections.js";

// ============================================================================
// Types
// ============================================================================

type MeasurementTab = "invocations" | "tasks" | "experiments" | "prompts" | "auto_merge";

interface DailyCostPoint {
  date: string;
  [providerId: string]: number | string; // dynamic provider keys
}

// ============================================================================
// Hooks
// ============================================================================

/** Default date range: last 30 days. */
function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

function useCostData(from: string, to: string): {
  rows: CostRollupRow[];
  loading: boolean;
  error: string | null;
} {
  const [rows, setRows] = useState<CostRollupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/measurement/cost?from=${from}&to=${to}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CostRollupRow[]>;
      })
      .then((data) => { setRows(data); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [from, to]);

  return { rows, loading, error };
}

function useAbExperiments(): {
  rows: AbExperimentRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<AbExperimentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projections/ab_experiment")
      .then((r) => r.json() as Promise<AbExperimentRow[]>)
      .then(setRows)
      .catch(() => {/* silently ignore */})
      .finally(() => setLoading(false));
  }, []);

  return { rows, loading };
}

function usePromptLibrary(): {
  rows: PromptVersionRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<PromptVersionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projections/prompt_library")
      .then((r) => r.json() as Promise<PromptVersionRow[]>)
      .then(setRows)
      .catch(() => {/* silently ignore */})
      .finally(() => setLoading(false));
  }, []);

  return { rows, loading };
}

function useTaskList(): {
  rows: TaskListRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<TaskListRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projections/task_list")
      .then((r) => r.json() as Promise<TaskListRow[]>)
      .then(setRows)
      .catch(() => {/* silently ignore */})
      .finally(() => setLoading(false));
  }, []);

  return { rows, loading };
}

// ============================================================================
// Helpers
// ============================================================================

/** Provider colour palette for charts. */
const PROVIDER_COLORS: Record<string, string> = {
  "anthropic-api": "#f59e0b",
  "claude-code": "#10b981",
  "openai-api": "#3b82f6",
  "codex": "#6366f1",
  "gemini-cli": "#8b5cf6",
};

function providerColor(providerId: string): string {
  return PROVIDER_COLORS[providerId] ?? "#94a3b8";
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${(usd * 1000).toFixed(2)}m`;
  return `$${(usd * 1000000).toFixed(0)}µ`;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Group raw CostRollupRows into daily invocation counts by provider. */
function toDailyInvocationPoints(rows: CostRollupRow[]): DailyCostPoint[] {
  const byDate = new Map<string, DailyCostPoint>();

  for (const row of rows) {
    if (!byDate.has(row.date)) {
      byDate.set(row.date, { date: row.date });
    }
    const point = byDate.get(row.date)!;
    const key = row.provider_id;
    point[key] = ((point[key] as number | undefined) ?? 0) + row.invocation_count;
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Get unique provider IDs from cost rows. */
function uniqueProviders(rows: CostRollupRow[]): string[] {
  return [...new Set(rows.map((r) => r.provider_id))];
}

// ============================================================================
// Components
// ============================================================================

/** Date range picker strip. */
function DateRangeStrip({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  function setPreset(days: number) {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    onChange(fromDate.toISOString().slice(0, 10), toDate.toISOString().slice(0, 10));
  }

  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-text-tertiary uppercase tracking-wide">Range</span>
      {[7, 14, 30, 90].map((days) => (
        <button
          key={days}
          onClick={() => setPreset(days)}
          className="px-2 py-0.5 text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors"
          data-testid={`preset-${days}d`}
        >
          {days}d
        </button>
      ))}
      <div className="flex items-center gap-1 ml-2">
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => onChange(e.target.value, to)}
          className="bg-surface-secondary text-text-primary border border-border px-1.5 py-0.5 text-xs"
          data-testid="date-from"
        />
        <span className="text-text-tertiary">—</span>
        <input
          type="date"
          value={to}
          min={from}
          onChange={(e) => onChange(from, e.target.value)}
          className="bg-surface-secondary text-text-primary border border-border px-1.5 py-0.5 text-xs"
          data-testid="date-to"
        />
      </div>
    </div>
  );
}

/** Summary stat card. */
function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-surface-secondary p-4">
      <p className="text-xs text-text-tertiary uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
      {sub && <p className="text-xs text-text-secondary mt-0.5">{sub}</p>}
    </div>
  );
}

// ============================================================================
// Invocations tab
// ============================================================================

function InvocationsTab({ rows, loading }: { rows: CostRollupRow[]; loading: boolean }) {
  const providers = useMemo(() => uniqueProviders(rows), [rows]);
  const dailyPoints = useMemo(() => toDailyInvocationPoints(rows), [rows]);

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">Loading…</div>;
  }

  const totalInvocations = rows.reduce((s, r) => s + r.invocation_count, 0);
  const avgPerDay = dailyPoints.length > 0 ? totalInvocations / dailyPoints.length : 0;

  return (
    <div className="flex-1 flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Total invocations" value={formatNumber(totalInvocations)} />
        <StatCard label="Avg / day" value={avgPerDay.toFixed(1)} />
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
          No invocation data for this period.
        </div>
      ) : (
        <div className="bg-surface-secondary p-4">
          <p className="text-xs text-text-tertiary uppercase tracking-wide mb-4">Daily invocations by provider</p>
          <ResponsiveContainer width="100%" height={240} data-testid="invocations-chart">
            <BarChart data={dailyPoints} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--color-text-tertiary)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--color-text-tertiary)" }} />
              <Tooltip
                contentStyle={{ background: "var(--color-surface-secondary)", border: "1px solid var(--color-border)", borderRadius: 6 }}
                labelStyle={{ color: "var(--color-text-primary)" }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {providers.map((pid) => (
                <Bar
                  key={pid}
                  dataKey={pid}
                  stackId="1"
                  fill={providerColor(pid)}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Tasks tab
// ============================================================================

const STATUS_COLORS: Record<string, string> = {
  queued: "#94a3b8",
  draft: "#64748b",
  running: "#f59e0b",
  paused: "#6366f1",
  awaiting_review: "#3b82f6",
  merged: "#10b981",
  rejected: "#ef4444",
  killed: "#ef4444",
  blocked: "#f97316",
};

function TasksTab({ rows, loading }: { rows: TaskListRow[]; loading: boolean }) {
  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">Loading…</div>;
  }

  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const total = rows.length;
  const merged = statusCounts.merged ?? 0;
  const successRate = total > 0 ? ((merged / total) * 100).toFixed(0) : "—";

  const chartData = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

  return (
    <div className="flex-1 flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total tasks" value={String(total)} />
        <StatCard label="Merged" value={String(merged)} sub="completed successfully" />
        <StatCard label="Success rate" value={total > 0 ? `${successRate}%` : "—"} />
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
          No tasks yet. Ingest a PRD to get started.
        </div>
      ) : (
        <div className="bg-surface-secondary p-4">
          <p className="text-xs text-text-tertiary uppercase tracking-wide mb-4">Task status breakdown</p>
          <ResponsiveContainer width="100%" height={200} data-testid="tasks-chart">
            <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis type="number" tick={{ fontSize: 10, fill: "var(--color-text-tertiary)" }} />
              <YAxis type="category" dataKey="status" tick={{ fontSize: 10, fill: "var(--color-text-tertiary)" }} />
              <Tooltip
                contentStyle={{ background: "var(--color-surface-secondary)", border: "1px solid var(--color-border)", borderRadius: 6 }}
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {chartData.map((entry) => (
                  <rect key={entry.status} fill={STATUS_COLORS[entry.status] ?? "#94a3b8"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// A/B Experiments tab
// ============================================================================

function pValueLabel(p: number | undefined): { text: string; significant: boolean } {
  if (p === undefined) return { text: "—", significant: false };
  return { text: `p = ${p.toFixed(3)}`, significant: p < 0.05 };
}

function AbExperimentsTab({ rows, loading }: { rows: AbExperimentRow[]; loading: boolean }) {
  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">Loading…</div>;
  }

  const running = rows.filter((r) => r.status === "running");
  const concluded = rows.filter((r) => r.status === "concluded");

  const ExperimentCard = ({ row }: { row: AbExperimentRow }) => {
    const pLabel = pValueLabel(row.significance_p);
    const aRate = (row.a_success_rate * 100).toFixed(0);
    const bRate = (row.b_success_rate * 100).toFixed(0);

    return (
      <div
        className="bg-surface-secondary p-4 border border-border"
        data-testid={`experiment-${row.experiment_id}`}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs font-mono text-text-tertiary">{row.experiment_id}</p>
            <p className="text-sm text-text-primary">{row.phase_class}</p>
          </div>
          <div className="flex items-center gap-2">
            {pLabel.text !== "—" && (
              <span
                className={`text-xs px-2 py-0.5 font-mono ${
                  pLabel.significant
                    ? "bg-status-healthy/20 text-status-healthy"
                    : "bg-surface-tertiary text-text-tertiary"
                }`}
                data-testid="p-value"
              >
                {pLabel.text}
              </span>
            )}
            <span
              className={`text-xs px-2 py-0.5 ${
                row.status === "running"
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-surface-tertiary text-text-tertiary"
              }`}
            >
              {row.status}
            </span>
            {row.winner && (
              <span className="text-xs px-2 py-0.5 bg-status-healthy/20 text-status-healthy">
                Winner: {row.winner}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Variant A */}
          <div className="bg-surface-primary p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-amber-400">Variant A</span>
              <span className="text-xs text-text-tertiary font-mono">{row.variant_a_id.slice(0, 8)}</span>
            </div>
            <p className="text-lg font-semibold text-text-primary">{aRate}%</p>
            <p className="text-xs text-text-tertiary">{row.a_n} runs · {formatCost(row.a_cost_usd)}</p>
          </div>

          {/* Variant B */}
          <div className="bg-surface-primary p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-blue-400">Variant B</span>
              <span className="text-xs text-text-tertiary font-mono">{row.variant_b_id.slice(0, 8)}</span>
            </div>
            <p className="text-lg font-semibold text-text-primary">{bRate}%</p>
            <p className="text-xs text-text-tertiary">{row.b_n} runs · {formatCost(row.b_cost_usd)}</p>
          </div>
        </div>
      </div>
    );
  };

  if (rows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        No A/B experiments yet. Start one from the Prompts section.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col gap-6 overflow-auto">
      {running.length > 0 && (
        <div>
          <p className="text-xs text-text-tertiary uppercase tracking-wide mb-3">Running ({running.length})</p>
          <div className="flex flex-col gap-3">
            {running.map((r) => <ExperimentCard key={r.experiment_id} row={r} />)}
          </div>
        </div>
      )}
      {concluded.length > 0 && (
        <div>
          <p className="text-xs text-text-tertiary uppercase tracking-wide mb-3">Concluded ({concluded.length})</p>
          <div className="flex flex-col gap-3">
            {concluded.map((r) => <ExperimentCard key={r.experiment_id} row={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Top Prompts tab
// ============================================================================

function TopPromptsTab({ rows, loading }: { rows: PromptVersionRow[]; loading: boolean }) {
  const [sortBy, setSortBy] = useState<"usage" | "success">("usage");

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">Loading…</div>;
  }

  const sorted = [...rows]
    .filter((r) => !r.retired)
    .sort((a, b) => {
      if (sortBy === "usage") return (b.invocations_last_30d ?? 0) - (a.invocations_last_30d ?? 0);
      return (b.success_rate_last_30d ?? 0) - (a.success_rate_last_30d ?? 0);
    });

  return (
    <div className="flex-1 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-tertiary">Sort by</span>
        {(["usage", "success"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSortBy(s)}
            className={`text-xs px-2 py-1 transition-colors ${
              sortBy === s
                ? "bg-amber-500/20 text-amber-400"
                : "text-text-secondary hover:text-text-primary"
            }`}
            data-testid={`sort-${s}`}
          >
            {s === "usage" ? "Usage (30d)" : "Success rate"}
          </button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
          No prompt versions yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((row, i) => {
            const rate = row.success_rate_last_30d;
            const rateStr = rate !== undefined ? `${(rate * 100).toFixed(0)}%` : "—";
            const costStr = row.avg_cost_usd !== undefined ? formatCost(row.avg_cost_usd) : "—";

            return (
              <div
                key={row.prompt_version_id}
                className="flex items-center gap-4 bg-surface-secondary px-4 py-3"
                data-testid={`prompt-row-${row.prompt_version_id}`}
              >
                <span className="text-xs text-text-tertiary w-5 text-right">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary truncate">{row.name}</p>
                  <p className="text-xs text-text-tertiary">{row.phase_class}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-mono text-text-primary">{row.invocations_last_30d ?? 0}</p>
                  <p className="text-xs text-text-tertiary">30d runs</p>
                </div>
                <div className="text-right w-14">
                  <p
                    className={`text-sm font-mono ${
                      rate !== undefined && rate >= 0.8
                        ? "text-status-healthy"
                        : rate !== undefined && rate >= 0.5
                        ? "text-status-warning"
                        : "text-text-tertiary"
                    }`}
                  >
                    {rateStr}
                  </p>
                  <p className="text-xs text-text-tertiary">success</p>
                </div>
                <div className="text-right w-16">
                  <p className="text-sm font-mono text-text-secondary">{costStr}</p>
                  <p className="text-xs text-text-tertiary">avg cost</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Auto-merge activity tab
// ============================================================================

function AutoMergeTab({ rows, loading }: { rows: TaskListRow[]; loading: boolean }) {
  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">Loading…</div>;
  }

  const mergedTasks = rows.filter((r) => r.status === "merged");
  const autoMerged = mergedTasks.filter((r) => r.auto_merged === true);
  const manualMerged = mergedTasks.filter((r) => !r.auto_merged);

  if (mergedTasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        No merge activity yet. Complete and merge tasks to see stats here.
      </div>
    );
  }

  const autoRate = mergedTasks.length > 0
    ? ((autoMerged.length / mergedTasks.length) * 100).toFixed(0)
    : "0";

  return (
    <div className="flex-1 flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Auto-merged" value={String(autoMerged.length)} sub={`${autoRate}% of all merges`} />
        <StatCard label="Manual merges" value={String(manualMerged.length)} />
        <StatCard label="Total merges" value={String(mergedTasks.length)} />
      </div>

      {/* Recent auto-merges table */}
      {autoMerged.length > 0 && (
        <div className="bg-surface-secondary p-4">
          <p className="text-xs text-text-tertiary uppercase tracking-wide mb-3">Recent auto-merges</p>
          <div className="space-y-2">
            {autoMerged.slice(0, 50).map((t) => (
              <div
                key={t.task_id}
                className="flex items-center justify-between px-3 py-2 bg-surface-primary"
              >
                <div>
                  <span className="text-sm text-text-primary">{t.title}</span>
                  <span className="ml-2 text-xs text-text-tertiary font-mono">{t.task_id}</span>
                </div>
                <span className="text-xs text-purple-400 font-medium px-2 py-0.5 bg-purple-500/10">
                  auto
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Measurement component
// ============================================================================

const TABS: Array<{ id: MeasurementTab; label: string; icon: React.FC<{ size?: number; className?: string }> }> = [
  { id: "invocations", label: "Invocations", icon: Zap },
  { id: "tasks", label: "Tasks", icon: BarChart3 },
  { id: "experiments", label: "A/B Experiments", icon: FlaskConical },
  { id: "prompts", label: "Top Prompts", icon: FileText },
  { id: "auto_merge", label: "Auto-merge", icon: GitMerge },
];

export function Measurement() {
  const [tab, setTab] = useState<MeasurementTab>("invocations");
  const [dateRange, setDateRange] = useState(defaultDateRange);

  const { rows: costRows, loading: costLoading } = useCostData(dateRange.from, dateRange.to);
  const { rows: abRows, loading: abLoading } = useAbExperiments();
  const { rows: promptRows, loading: promptLoading } = usePromptLibrary();
  const { rows: taskRows, loading: taskLoading } = useTaskList();

  return (
    <div className="flex-1 flex flex-col p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-xs text-text-tertiary uppercase tracking-wide">Section</p>
          <h1 className="text-2xl font-semibold text-text-primary">Measurement</h1>
          <p className="text-xs text-text-tertiary mt-1">Token usage and invocation metrics across providers.</p>
        </div>
        {tab === "invocations" && (
          <DateRangeStrip
            from={dateRange.from}
            to={dateRange.to}
            onChange={(from, to) => setDateRange({ from, to })}
          />
        )}
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as MeasurementTab)}
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="mb-6">
          {TABS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} data-testid={`tab-${id}`} className="flex items-center gap-1.5">
              <Icon size={13} />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsPanel value="invocations" className="flex-1 flex flex-col min-h-0">
          <InvocationsTab rows={costRows} loading={costLoading} />
        </TabsPanel>
        <TabsPanel value="tasks" className="flex-1 flex flex-col min-h-0">
          <TasksTab rows={taskRows} loading={taskLoading} />
        </TabsPanel>
        <TabsPanel value="experiments" className="flex-1 flex flex-col min-h-0">
          <AbExperimentsTab rows={abRows} loading={abLoading} />
        </TabsPanel>
        <TabsPanel value="prompts" className="flex-1 flex flex-col min-h-0">
          <TopPromptsTab rows={promptRows} loading={promptLoading} />
        </TabsPanel>
        <TabsPanel value="auto_merge" className="flex-1 flex flex-col min-h-0">
          <AutoMergeTab rows={taskRows} loading={taskLoading} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
