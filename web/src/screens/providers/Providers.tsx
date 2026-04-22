/**
 * Providers section — provider health cards with re-probe, edit config,
 * latency sparkline, and model list.
 *
 * Each card shows:
 *   - Status badge (healthy / degraded / down / unknown)
 *   - Transport type, binary_path (CLI) or endpoint (API)
 *   - Auth method + auth_present indicator
 *   - Latency SVG sparkline (last 24h of probe events)
 *   - Advertised models (API providers)
 *   - last_error (when down/degraded)
 *   - Re-probe + Edit config action buttons
 *
 * Props:
 *   focusedProvider? — provider_id to highlight on mount (e.g., from top-bar pill click)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  RefreshCw,
  SlidersHorizontal,
  Plus,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  X,
} from "lucide-react";
import type { ProviderHealthRow } from "@shared/projections.js";

// ============================================================================
// Types
// ============================================================================

type ProvidersProps = {
  focusedProvider?: string;
};

type ProbeEvent = {
  id: string;
  ts: string;
  payload: { latency_ms?: number; status?: string };
};

type EditState = {
  binary_path: string;
  endpoint: string;
  auth_method: "env_var" | "keychain" | "cli_login";
};

type ProviderStatus = ProviderHealthRow["status"];

// ============================================================================
// Helpers
// ============================================================================

const STATUS_COLORS: Record<ProviderStatus, string> = {
  healthy: "text-status-healthy",
  degraded: "text-status-warning",
  down: "text-status-danger",
  unknown: "text-status-muted",
};

const STATUS_DOT: Record<ProviderStatus, string> = {
  healthy: "bg-status-healthy",
  degraded: "bg-status-warning",
  down: "bg-status-danger",
  unknown: "bg-status-muted",
};

const STATUS_ICONS: Record<ProviderStatus, React.ElementType> = {
  healthy: CheckCircle2,
  degraded: AlertTriangle,
  down: XCircle,
  unknown: HelpCircle,
};

/** Display-friendly status label — "not found" for CLI providers that are down */
function statusLabel(status: ProviderStatus, isCli: boolean): string {
  if (status === "down" && isCli) return "not found";
  return status;
}

function formatLatency(ms?: number): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// Sparkline — simple SVG polyline from probe event latencies
// ============================================================================

type SparklineProps = {
  providerId: string;
  events: ProbeEvent[];
};

function Sparkline({ providerId, events }: SparklineProps) {
  const W = 80;
  const H = 24;

  const latencies = events
    .slice()
    .reverse() // chronological order
    .map((e) => e.payload.latency_ms ?? 0)
    .filter((v) => v > 0);

  if (latencies.length < 2) {
    return (
      <svg
        data-testid={`sparkline-${providerId}`}
        width={W}
        height={H}
        className="opacity-30"
      >
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="currentColor" strokeWidth={1} />
      </svg>
    );
  }

  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const range = max - min || 1;

  const points = latencies.map((v, i) => {
    const x = (i / (latencies.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      data-testid={`sparkline-${providerId}`}
      width={W}
      height={H}
      className="text-status-healthy opacity-70"
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ============================================================================
// Edit Config Form
// ============================================================================

type EditConfigFormProps = {
  row: ProviderHealthRow;
  onSave: (values: Partial<EditState>) => Promise<void>;
  onCancel: () => void;
};

function EditConfigForm({ row, onSave, onCancel }: EditConfigFormProps) {
  const isCli = row.transport !== "anthropic-api" && row.transport !== "openai-api";
  const [binaryPath, setBinaryPath] = useState(row.binary_path ?? "");
  const [endpoint, setEndpoint] = useState(row.endpoint ?? "");
  const [authMethod, setAuthMethod] = useState<EditState["auth_method"]>(
    row.auth_method ?? "cli_login",
  );
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        ...(isCli ? { binary_path: binaryPath } : { endpoint }),
        auth_method: authMethod,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-3 border border-border-default p-3 bg-bg-secondary space-y-3">
      {isCli ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`binary-path-${row.provider_id}`} className="text-xs text-text-secondary">
            Binary Path
          </label>
          <input
            id={`binary-path-${row.provider_id}`}
            aria-label="Binary Path"
            type="text"
            value={binaryPath}
            onChange={(e) => setBinaryPath(e.target.value)}
            className="text-xs bg-bg-primary border border-border-default px-2 py-1 text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-border-default"
            placeholder="/usr/local/bin/claude"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor={`endpoint-${row.provider_id}`} className="text-xs text-text-secondary">
            Endpoint
          </label>
          <input
            id={`endpoint-${row.provider_id}`}
            aria-label="Endpoint"
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="text-xs bg-bg-primary border border-border-default px-2 py-1 text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-border-default"
            placeholder="https://api.anthropic.com"
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={`auth-method-${row.provider_id}`} className="text-xs text-text-secondary">
          Auth Method
        </label>
        {isCli ? (
          /* CLI providers always use cli_login — read-only */
          <input
            id={`auth-method-${row.provider_id}`}
            aria-label="Auth Method"
            type="text"
            value="cli_login"
            readOnly
            className="text-xs bg-bg-primary border border-border-default px-2 py-1 text-text-tertiary font-mono cursor-not-allowed"
          />
        ) : (
          /* API providers only support env_var for now */
          <input
            id={`auth-method-${row.provider_id}`}
            aria-label="Auth Method"
            type="text"
            value="env_var"
            readOnly
            className="text-xs bg-bg-primary border border-border-default px-2 py-1 text-text-tertiary font-mono cursor-not-allowed"
          />
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="text-xs px-3 py-1 bg-bg-inverse text-text-inverse hover:opacity-80 transition-opacity disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1 border border-border-default text-text-secondary hover:bg-bg-secondary transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ============================================================================
// Provider Card
// ============================================================================

type ProviderCardProps = {
  row: ProviderHealthRow;
  probeEvents: ProbeEvent[];
  focused: boolean;
  onReprobe: () => Promise<void>;
  onConfigure: (values: Partial<EditState>) => Promise<void>;
};

function ProviderCard({ row, probeEvents, focused, onReprobe, onConfigure }: ProviderCardProps) {
  const [editing, setEditing] = useState(false);
  const [reprobing, setReprobing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll focused card into view on mount (guard for jsdom which lacks scrollIntoView)
  useEffect(() => {
    if (focused && cardRef.current && typeof cardRef.current.scrollIntoView === "function") {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focused]);

  const StatusIcon = STATUS_ICONS[row.status];
  const isCli = row.transport !== "anthropic-api" && row.transport !== "openai-api";

  const handleReprobe = async () => {
    setReprobing(true);
    try {
      await onReprobe();
    } finally {
      setReprobing(false);
    }
  };

  const handleSave = async (values: Partial<EditState>) => {
    await onConfigure(values);
    setEditing(false);
  };

  return (
    <div
      ref={cardRef}
      data-focused={focused ? "true" : undefined}
      className={`border ${focused ? "border-text-primary shadow-lg" : "border-border-default"} bg-bg-secondary p-4 space-y-3`}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className={`inline-block h-2.5 w-2.5 rounded-full mt-0.5 ${STATUS_DOT[row.status]}`} />
          <div>
            <div className="flex items-center gap-2">
              <span data-testid="provider-name" className="font-semibold text-sm text-text-primary">{row.provider_id}</span>
              <span className="text-xs text-text-tertiary bg-bg-tertiary px-1.5 py-0.5">
                {row.transport}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <StatusIcon className={`h-3 w-3 ${STATUS_COLORS[row.status]}`} />
              <span className={`text-xs ${STATUS_COLORS[row.status]}`}>{statusLabel(row.status, isCli)}</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleReprobe}
            disabled={reprobing}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 border border-border-default text-text-secondary hover:bg-bg-tertiary transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`h-3 w-3 ${reprobing ? "animate-spin" : ""}`} />
            Re-probe
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 border border-border-default text-text-secondary hover:bg-bg-tertiary transition-colors"
          >
            {editing ? <X className="h-3 w-3" /> : <SlidersHorizontal className="h-3 w-3" />}
            {editing ? "Close" : "Edit config"}
          </button>
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {/* Binary path or endpoint */}
        {isCli && row.binary_path && (
          <>
            <span className="text-text-tertiary">Binary</span>
            <span className="text-text-primary font-mono truncate">
              {row.binary_path}
              {row.status !== "down" && !row.binary_path.includes("/") && (
                <span className="text-text-tertiary font-sans"> · Found on PATH</span>
              )}
            </span>
          </>
        )}
        {!isCli && row.endpoint && (
          <>
            <span className="text-text-tertiary">Endpoint</span>
            <span className="text-text-primary font-mono truncate">{row.endpoint}</span>
          </>
        )}

        {/* Auth — hide indicator for cli_login since the orchestrator can't verify it */}
        <span className="text-text-tertiary">Auth</span>
        <div className="flex items-center gap-1.5">
          <span className="text-text-primary">{row.auth_method}</span>
          {row.auth_method !== "cli_login" && (
            row.auth_present ? (
              <span className="text-status-healthy text-xs font-medium">auth ok</span>
            ) : (
              <span className="text-status-danger text-xs font-medium">auth missing</span>
            )
          )}
        </div>

        {/* Latency — hide when provider is down since the value is just error-handling overhead */}
        {row.status !== "down" && (
          <>
            <span className="text-text-tertiary">Latency</span>
            <div className="flex items-center gap-3">
              <span className="text-text-primary">{formatLatency(row.latency_ms)}</span>
              <Sparkline providerId={row.provider_id} events={probeEvents} />
            </div>
          </>
        )}

        {/* Last probe */}
        {row.last_probe_at && (
          <>
            <span className="text-text-tertiary">Last probe</span>
            <span className="text-text-secondary">
              {new Date(row.last_probe_at).toLocaleTimeString()}
            </span>
          </>
        )}
      </div>

      {/* Models list (API providers) */}
      {row.models && row.models.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-text-tertiary">Models</span>
          <div className="flex flex-wrap gap-1.5">
            {row.models.map((m) => (
              <span
                key={m}
                className="text-xs bg-bg-tertiary text-text-secondary px-2 py-0.5 font-mono"
              >
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {row.last_error && (
        <div className="text-xs text-status-danger bg-bg-primary border border-status-danger/20 px-2.5 py-1.5">
          {row.last_error}
        </div>
      )}

      {/* Edit config form */}
      {editing && (
        <EditConfigForm
          row={row}
          onSave={handleSave}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Hook — fetches provider health rows and per-provider probe events
// ============================================================================

function useProviderHealth() {
  const [rows, setRows] = useState<ProviderHealthRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projections/provider_health");
      if (res.ok) setRows(await res.json());
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { rows, loading, reload: load, setRows };
}

function useProbeHistory(providerId: string): ProbeEvent[] {
  const [events, setEvents] = useState<ProbeEvent[]>([]);

  useEffect(() => {
    let active = true;
    fetch(`/api/events/recent?aggregate_id=${encodeURIComponent(providerId)}&limit=48`)
      .then((r) => r.json())
      .then((data: unknown[]) => {
        if (!active) return;
        setEvents(
          (data as ProbeEvent[]).filter((e) => e.payload?.latency_ms != null),
        );
      })
      .catch(() => {/* silent */});
    return () => { active = false; };
  }, [providerId]);

  return events;
}

// ============================================================================
// Provider Card wrapper with probe history
// ============================================================================

type ProviderCardWithHistoryProps = {
  row: ProviderHealthRow;
  focused: boolean;
  onReprobe: (id: string) => Promise<ProviderHealthRow>;
  onConfigure: (id: string, values: Partial<EditState>) => Promise<void>;
};

function ProviderCardWithHistory({ row, focused, onReprobe, onConfigure }: ProviderCardWithHistoryProps) {
  const probeEvents = useProbeHistory(row.provider_id);

  return (
    <ProviderCard
      row={row}
      probeEvents={probeEvents}
      focused={focused}
      onReprobe={() => onReprobe(row.provider_id).then(() => undefined)}
      onConfigure={(values) => onConfigure(row.provider_id, values)}
    />
  );
}

// ============================================================================
// Main screen
// ============================================================================

export function Providers({ focusedProvider }: ProvidersProps = {}) {
  const { rows, loading, reload, setRows } = useProviderHealth();

  const handleReprobe = useCallback(async (providerId: string): Promise<ProviderHealthRow> => {
    const res = await fetch(`/api/providers/probe/${encodeURIComponent(providerId)}`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Probe failed: ${res.status}`);
    const updated: ProviderHealthRow = await res.json();
    setRows((prev) => prev.map((r) => (r.provider_id === providerId ? updated : r)));
    return updated;
  }, [setRows]);

  const handleConfigure = useCallback(async (
    providerId: string,
    values: Partial<EditState>,
  ): Promise<void> => {
    const res = await fetch(`/api/providers/configure/${encodeURIComponent(providerId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!res.ok) throw new Error(`Configure failed: ${res.status}`);
    const updated: ProviderHealthRow = await res.json();
    setRows((prev) => prev.map((r) => (r.provider_id === providerId ? updated : r)));
  }, [setRows]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border-default shrink-0">
        <div>
          <p className="text-xs text-text-tertiary uppercase tracking-wide">Providers</p>
          <h1 className="text-lg font-semibold text-text-primary">Provider Health</h1>
          <p className="text-xs text-text-tertiary mt-1">Status, auth, and latency for each configured AI provider.</p>
        </div>
        <button
          type="button"
          onClick={reload}
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {loading && (
          <div className="text-sm text-text-tertiary py-8 text-center">Loading providers…</div>
        )}

        {!loading && rows.length === 0 && (
          <div className="text-sm text-text-tertiary py-8 text-center">No providers configured.</div>
        )}

        {!loading && rows.map((row) => (
          <ProviderCardWithHistory
            key={row.provider_id}
            row={row}
            focused={row.provider_id === focusedProvider}
            onReprobe={handleReprobe}
            onConfigure={handleConfigure}
          />
        ))}

        {/* Add provider button */}
        <button
          type="button"
          className="w-full flex items-center justify-center gap-2 border border-dashed border-border-default text-text-tertiary hover:border-text-tertiary hover:text-text-secondary transition-colors py-3 text-sm"
        >
          <Plus className="h-4 w-4" />
          Add provider
        </button>
      </div>
    </div>
  );
}
