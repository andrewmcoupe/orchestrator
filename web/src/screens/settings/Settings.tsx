/**
 * Settings section — Presets, Gates, Defaults, API Keys, About.
 *
 * Data sources:
 *   /api/projections/preset     — preset library
 *   /api/settings/gates         — gate library (config + custom)
 *   /api/settings/defaults      — global defaults
 *   /api/projections/provider_health — API key status
 *   /api/settings/about         — version/stats
 */

import { useState, useEffect, useCallback } from "react";
import {
  Sliders,
  GitBranch,
  Settings2,
  Key,
  Info,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Wrench,
} from "lucide-react";
import type { PresetRow, ProviderHealthRow, GateLibraryRow, GlobalSettingsRow } from "@shared/projections.js";
import type { GateConfig } from "@shared/events.js";
import { Maintenance } from "./Maintenance.js";

// ============================================================================
// Types
// ============================================================================

type SettingsTab = "presets" | "gates" | "defaults" | "api_keys" | "maintenance" | "about";

interface GateWithSource extends GateConfig {
  source: "config" | "library";
}

interface GatesResponse {
  config_gates: GateConfig[];
  library_gates: GateLibraryRow[];
  all_gates: GateWithSource[];
  config_gate_names: string[];
}

interface AboutInfo {
  version: string;
  event_count: number;
  db_size_bytes: number;
  db_path: string;
  env_local_path: string;
  repo_root: string;
  projections: string[];
}

// ============================================================================
// Hooks
// ============================================================================

function usePresets() {
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/projections/preset")
      .then((r) => r.json() as Promise<PresetRow[]>)
      .then((data) => setPresets(Array.isArray(data) ? data : []))
      .catch(() => setPresets([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return { presets, loading, reload: load };
}

function useGates() {
  const [data, setData] = useState<GatesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/settings/gates")
      .then((r) => r.json() as Promise<GatesResponse>)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return { data, loading, reload: load };
}

function useDefaults() {
  const [defaults, setDefaults] = useState<GlobalSettingsRow | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/settings/defaults")
      .then((r) => r.json() as Promise<GlobalSettingsRow>)
      .then(setDefaults)
      .catch(() => setDefaults(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return { defaults, loading, reload: load };
}

function useProviderHealth() {
  const [providers, setProviders] = useState<ProviderHealthRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projections/provider_health")
      .then((r) => r.json() as Promise<ProviderHealthRow[]>)
      .then(setProviders)
      .catch(() => setProviders([]))
      .finally(() => setLoading(false));
  }, []);

  return { providers, loading };
}

function useAbout() {
  const [about, setAbout] = useState<AboutInfo | null>(null);

  useEffect(() => {
    fetch("/api/settings/about")
      .then((r) => r.json() as Promise<AboutInfo>)
      .then(setAbout)
      .catch(() => setAbout(null));
  }, []);

  return { about };
}

// ============================================================================
// Presets subsection
// ============================================================================

function PresetsSection() {
  const { presets, loading, reload } = usePresets();
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (presetId: string) => {
    setDeleting(presetId);
    try {
      await fetch(`/api/commands/preset/delete/${presetId}`, { method: "POST" });
      reload();
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <div className="text-sm text-text-secondary p-4">Loading presets…</div>;

  return (
    <div data-testid="presets-section">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-text-primary">Preset Library</h2>
        <span className="text-xs text-text-tertiary">{presets.length} presets</span>
      </div>
      {presets.length === 0 ? (
        <p className="text-sm text-text-secondary">No presets configured.</p>
      ) : (
        <div className="space-y-2">
          {presets.map((p) => (
            <div
              key={p.preset_id}
              className="flex items-center justify-between border border-surface-tertiary bg-surface-secondary px-4 py-3"
            >
              <div>
                <div className="text-sm font-medium text-text-primary">{p.name}</div>
                <div className="text-xs text-text-tertiary mt-0.5">
                  {p.task_class} · updated {new Date(p.updated_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleDelete(p.preset_id)}
                  disabled={deleting === p.preset_id}
                  className="text-xs text-text-tertiary hover:text-danger px-2 py-1"
                  data-testid={`delete-preset-${p.preset_id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 text-xs text-text-tertiary">
        Presets are created from the task config screen ("Save as preset") or via the API.
      </p>
    </div>
  );
}

// ============================================================================
// Gates subsection
// ============================================================================

type GateFormState = {
  name: string;
  command: string;
  required: boolean;
  timeout_seconds: number;
  on_fail: GateConfig["on_fail"];
};

const EMPTY_GATE: GateFormState = {
  name: "",
  command: "",
  required: true,
  timeout_seconds: 60,
  on_fail: "fail_task",
};

function GatesSection() {
  const { data, loading, reload } = useGates();
  const [editing, setEditing] = useState<GateFormState | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleAdd = () => {
    setIsNew(true);
    setEditing({ ...EMPTY_GATE });
  };

  const handleEdit = (gate: GateConfig) => {
    setIsNew(false);
    setEditing({ ...gate });
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const url = isNew
        ? "/api/commands/gate_library/add"
        : `/api/commands/gate_library/update/${editing.name}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      if (r.ok) {
        setEditing(null);
        reload();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (name: string) => {
    await fetch(`/api/commands/gate_library/remove/${name}`, { method: "POST" });
    reload();
  };

  if (loading) return <div className="text-sm text-text-secondary p-4">Loading gates…</div>;

  const allGates = data?.all_gates ?? [];

  return (
    <div data-testid="gates-section">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-text-primary">Gate Library</h2>
        <button
          onClick={handleAdd}
          className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-surface-tertiary hover:bg-surface-inverse text-text-primary"
          data-testid="add-gate-btn"
        >
          <Plus className="h-3 w-3" /> Add gate
        </button>
      </div>

      {editing && (
        <div className="mb-4 border border-surface-inverse bg-surface-secondary p-4 space-y-3" data-testid="gate-form">
          <h3 className="text-sm font-medium text-text-primary">{isNew ? "New gate" : `Edit: ${editing.name}`}</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-secondary">Name</span>
              <input
                className="border border-surface-tertiary bg-surface-primary px-2 py-1 text-sm text-text-primary"
                value={editing.name}
                readOnly={!isNew}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                data-testid="gate-name-input"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-secondary">Command</span>
              <input
                className="border border-surface-tertiary bg-surface-primary px-2 py-1 text-sm text-text-primary"
                value={editing.command}
                onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                data-testid="gate-command-input"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-secondary">Timeout (seconds)</span>
              <input
                type="number"
                className="border border-surface-tertiary bg-surface-primary px-2 py-1 text-sm text-text-primary"
                value={editing.timeout_seconds}
                onChange={(e) => setEditing({ ...editing, timeout_seconds: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-secondary">On fail</span>
              <select
                className="border border-surface-tertiary bg-surface-primary px-2 py-1 text-sm text-text-primary"
                value={editing.on_fail}
                onChange={(e) => setEditing({ ...editing, on_fail: e.target.value as GateConfig["on_fail"] })}
              >
                <option value="retry">retry</option>
                <option value="retry_with_context">retry_with_context</option>
                <option value="skip">skip</option>
                <option value="fail_task">fail_task</option>
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={editing.required}
              onChange={(e) => setEditing({ ...editing, required: e.target.checked })}
            />
            Required
          </label>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || !editing.name || !editing.command}
              className="px-3 py-1.5 text-xs bg-status-healthy text-white disabled:opacity-50"
              data-testid="save-gate-btn"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(null)}
              className="px-3 py-1.5 text-xs bg-surface-tertiary text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {allGates.length === 0 && !editing ? (
        <p className="text-sm text-text-secondary">No gates in the library. Add one to make it available in task configs.</p>
      ) : (
        <div className="space-y-2">
          {allGates.map((g) => (
            <div
              key={g.name}
              className="flex items-center justify-between border border-surface-tertiary bg-surface-secondary px-4 py-3"
              data-testid={`gate-row-${g.name}`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{g.name}</span>
                  <span className={`text-xs px-1.5 py-0.5 ${g.source === "library" ? "bg-status-healthy/20 text-status-healthy" : "bg-surface-tertiary text-text-tertiary"}`}>
                    {g.source}
                  </span>
                  {g.required && <span className="text-xs text-text-tertiary">required</span>}
                </div>
                <div className="text-xs text-text-tertiary font-mono mt-0.5">{g.command}</div>
              </div>
              {g.source === "library" && (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEdit(g)}
                    className="text-xs text-text-tertiary hover:text-text-primary p-1"
                    data-testid={`edit-gate-${g.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleRemove(g.name)}
                    className="text-xs text-text-tertiary hover:text-danger p-1"
                    data-testid={`remove-gate-${g.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Defaults subsection
// ============================================================================

function DefaultsSection() {
  const { defaults, loading, reload } = useDefaults();
  const [form, setForm] = useState<{
    default_preset_id: string;
    auto_delete_worktree_on_merge: boolean;
    auto_pause_on_external_fs_change: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Auto-merge master switch — independent from the form (fires its own event)
  const [autoMergeEnabled, setAutoMergeEnabled] = useState(false);
  const [togglingAutoMerge, setTogglingAutoMerge] = useState(false);

  // Advisory banner: count of task.would_auto_merge events in last 7 days
  const [wouldAutoMergeCount, setWouldAutoMergeCount] = useState<number | null>(null);

  useEffect(() => {
    if (defaults && !form) {
      setForm({
        default_preset_id: defaults.default_preset_id ?? "",
        auto_delete_worktree_on_merge: defaults.auto_delete_worktree_on_merge,
        auto_pause_on_external_fs_change: defaults.auto_pause_on_external_fs_change,
      });
      setAutoMergeEnabled(defaults.auto_merge_enabled ?? false);
    }
  }, [defaults, form]);

  // Fetch would-auto-merge event count when auto-merge is enabled
  useEffect(() => {
    if (!autoMergeEnabled) {
      setWouldAutoMergeCount(null);
      return;
    }
    fetch("/api/events/recent?type=task.would_auto_merge&limit=100")
      .then((r) => r.json() as Promise<Array<{ type: string; ts: string }>>)
      .then((events) => {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recent = events.filter(
          (e) => e.type === "task.would_auto_merge" && new Date(e.ts).getTime() > sevenDaysAgo,
        );
        setWouldAutoMergeCount(recent.length);
      })
      .catch(() => setWouldAutoMergeCount(null));
  }, [autoMergeEnabled]);

  const handleToggleAutoMerge = async () => {
    setTogglingAutoMerge(true);
    try {
      await fetch("/api/commands/settings/auto-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !autoMergeEnabled }),
      });
      setAutoMergeEnabled(!autoMergeEnabled);
    } finally {
      setTogglingAutoMerge(false);
    }
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (form.default_preset_id !== (defaults?.default_preset_id ?? "")) {
        changes.default_preset_id = form.default_preset_id || null;
      }
      if (form.auto_delete_worktree_on_merge !== (defaults?.auto_delete_worktree_on_merge ?? false)) {
        changes.auto_delete_worktree_on_merge = form.auto_delete_worktree_on_merge;
      }
      if (form.auto_pause_on_external_fs_change !== (defaults?.auto_pause_on_external_fs_change ?? false)) {
        changes.auto_pause_on_external_fs_change = form.auto_pause_on_external_fs_change;
      }

      if (Object.keys(changes).length === 0) return;

      await fetch("/api/commands/settings/defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      reload();
    } finally {
      setSaving(false);
    }
  };

  if (loading || !form) return <div className="text-sm text-text-secondary p-4">Loading defaults…</div>;

  return (
    <div data-testid="defaults-section" className="space-y-6">
      <h2 className="text-base font-semibold text-text-primary">Global Defaults</h2>
      <p className="text-sm text-text-secondary">
        These settings are inherited by new tasks. Changes persist via events and survive restarts.
      </p>

      <div className="space-y-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text-primary">Default preset ID</span>
          <span className="text-xs text-text-tertiary">Applied to new tasks when no preset is explicitly chosen.</span>
          <input
            className="mt-1 border border-surface-tertiary bg-surface-secondary px-3 py-1.5 text-sm text-text-primary max-w-xs"
            placeholder="e.g. preset-default-new-feature"
            value={form.default_preset_id}
            onChange={(e) => setForm({ ...form, default_preset_id: e.target.value })}
            data-testid="default-preset-input"
          />
        </label>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.auto_delete_worktree_on_merge}
            onChange={(e) => setForm({ ...form, auto_delete_worktree_on_merge: e.target.checked })}
            data-testid="auto-delete-worktree-checkbox"
          />
          <div>
            <div className="text-sm font-medium text-text-primary">Auto-delete worktree on merge</div>
            <div className="text-xs text-text-tertiary">Remove the git worktree when a task is merged.</div>
          </div>
        </label>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.auto_pause_on_external_fs_change}
            onChange={(e) => setForm({ ...form, auto_pause_on_external_fs_change: e.target.checked })}
            data-testid="auto-pause-checkbox"
          />
          <div>
            <div className="text-sm font-medium text-text-primary">Auto-pause on external filesystem change</div>
            <div className="text-xs text-text-tertiary">Pause the active attempt if files in the worktree are modified externally.</div>
          </div>
        </label>
      </div>

      {/* Auto-merge master switch — visually prominent */}
      <div className="border-2 border-purple-500/30 bg-purple-500/5 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-text-primary">Auto-merge</h3>
            <p className="text-xs text-text-tertiary mt-0.5">
              When enabled, tasks with an auto-merge policy can merge automatically after a successful attempt.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoMergeEnabled}
            disabled={togglingAutoMerge}
            onClick={handleToggleAutoMerge}
            data-testid="auto-merge-master-switch"
            className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
              autoMergeEnabled ? "bg-purple-600" : "bg-bg-tertiary"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                autoMergeEnabled ? "translate-x-8" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Advisory banner: would-auto-merge count in last 7 days */}
        {autoMergeEnabled && wouldAutoMergeCount !== null && wouldAutoMergeCount > 0 && (
          <div
            data-testid="auto-merge-advisory-banner"
            className="bg-purple-500/10 border border-purple-500/20 px-4 py-2.5 text-sm text-purple-300"
          >
            {wouldAutoMergeCount} {wouldAutoMergeCount === 1 ? "task" : "tasks"} would have auto-merged in the last 7 days.
          </div>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 text-sm bg-status-healthy text-white disabled:opacity-50"
        data-testid="save-defaults-btn"
      >
        {saving ? "Saving…" : saved ? "Saved ✓" : "Save defaults"}
      </button>
    </div>
  );
}

// ============================================================================
// API Keys subsection
// ============================================================================

function ApiKeysSection() {
  const { providers, loading } = useProviderHealth();

  if (loading) return <div className="text-sm text-text-secondary p-4">Loading providers…</div>;

  const apiProviders = providers.filter(
    (p) => p.transport === "anthropic-api" || p.transport === "openai-api" || p.transport === "gemini-cli",
  );

  return (
    <div data-testid="api-keys-section" className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">API Keys</h2>
      <p className="text-sm text-text-secondary">
        Keys are read from <code className="font-mono text-xs">.env.local</code> at boot.
        Key values are never displayed here or stored in the event log.
      </p>

      <div className="space-y-2">
        {apiProviders.length === 0 ? (
          <p className="text-sm text-text-secondary">No API providers configured.</p>
        ) : (
          apiProviders.map((p) => (
            <div
              key={p.provider_id}
              className="flex items-center justify-between border border-surface-tertiary bg-surface-secondary px-4 py-3"
              data-testid={`provider-key-${p.provider_id}`}
            >
              <div>
                <div className="text-sm font-medium text-text-primary">{p.provider_id}</div>
                <div className="text-xs text-text-tertiary">{p.auth_method}</div>
              </div>
              {p.auth_present ? (
                <div className="flex items-center gap-1.5 text-xs text-status-healthy" data-testid="auth-present">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  present
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-danger" data-testid="auth-missing">
                  <XCircle className="h-3.5 w-3.5" />
                  missing
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="border border-surface-tertiary bg-surface-secondary p-4">
        <div className="text-xs font-medium text-text-secondary mb-1">CLI providers</div>
        {providers
          .filter((p) => p.transport !== "anthropic-api" && p.transport !== "openai-api")
          .map((p) => (
            <div key={p.provider_id} className="flex items-center justify-between py-1" data-testid={`cli-provider-${p.provider_id}`}>
              <span className="text-sm text-text-primary">{p.provider_id}</span>
              <span className={`text-xs ${p.status === "healthy" ? "text-status-healthy" : "text-danger"}`}>
                {p.status}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ============================================================================
// About subsection
// ============================================================================

function AboutSection() {
  const { about } = useAbout();
  const [rebuilding, setRebuilding] = useState<string | null>(null);
  const [rebuildResults, setRebuildResults] = useState<Record<string, "ok" | "error">>({});

  const handleRebuild = async (name: string) => {
    setRebuilding(name);
    try {
      const r = await fetch(`/api/maintenance/rebuild/${name}`, { method: "POST" });
      setRebuildResults((prev) => ({ ...prev, [name]: r.ok ? "ok" : "error" }));
      setTimeout(() => setRebuildResults((prev) => {
        const n = { ...prev };
        delete n[name];
        return n;
      }), 3000);
    } finally {
      setRebuilding(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div data-testid="about-section" className="space-y-6">
      <h2 className="text-base font-semibold text-text-primary">About</h2>

      {about && (
        <div className="space-y-2">
          <div className="border border-surface-tertiary bg-surface-secondary p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Version</span>
              <span className="text-text-primary font-mono">{about.version}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Event log size</span>
              <span className="text-text-primary">{about.event_count.toLocaleString()} events ({formatBytes(about.db_size_bytes)})</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Host repo</span>
              <span className="text-text-primary font-mono text-xs truncate max-w-48" title={about.repo_root}>{about.repo_root}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">DB path</span>
              <span className="text-text-primary font-mono text-xs truncate max-w-48" title={about.db_path}>{about.db_path}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">.env.local path</span>
              <span className="text-text-primary font-mono text-xs truncate max-w-48" title={about.env_local_path}>{about.env_local_path}</span>
            </div>
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Rebuild Projections</h3>
        <p className="text-xs text-text-tertiary mb-3">
          Rebuilding replays all events through the projection reducer, replacing any stale state.
          The event log itself is never modified.
        </p>
        <div className="space-y-2">
          {(about?.projections ?? []).map((name) => (
            <div
              key={name}
              className="flex items-center justify-between border border-surface-tertiary bg-surface-secondary px-4 py-2.5"
              data-testid={`rebuild-row-${name}`}
            >
              <span className="text-sm font-mono text-text-primary">{name}</span>
              <button
                onClick={() => handleRebuild(name)}
                disabled={rebuilding === name}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-surface-tertiary hover:bg-surface-inverse text-text-primary disabled:opacity-50"
                data-testid={`rebuild-btn-${name}`}
              >
                <RefreshCw className={`h-3 w-3 ${rebuilding === name ? "animate-spin" : ""}`} />
                {rebuilding === name ? "Rebuilding…" : rebuildResults[name] === "ok" ? "Done ✓" : rebuildResults[name] === "error" ? "Error ✗" : "Rebuild"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Settings component
// ============================================================================

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Sliders }> = [
  { id: "presets", label: "Presets", icon: Sliders },
  { id: "gates", label: "Gates", icon: GitBranch },
  { id: "defaults", label: "Defaults", icon: Settings2 },
  { id: "api_keys", label: "API Keys", icon: Key },
  { id: "maintenance", label: "Maintenance", icon: Wrench },
  { id: "about", label: "About", icon: Info },
];

export function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("presets");

  return (
    <div className="flex flex-1 overflow-hidden" data-testid="settings-screen">
      {/* Left nav */}
      <nav className="w-48 border-r border-surface-tertiary bg-surface-secondary flex-shrink-0 py-4">
        <p className="text-xs text-text-tertiary uppercase tracking-wide px-4 mb-2">Settings</p>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors ${
              activeTab === id
                ? "bg-surface-inverse text-text-primary border-r-2 border-status-healthy"
                : "text-text-secondary hover:text-text-primary hover:bg-surface-tertiary"
            }`}
            data-testid={`settings-tab-${id}`}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-8">
        {activeTab === "presets" && <PresetsSection />}
        {activeTab === "gates" && <GatesSection />}
        {activeTab === "defaults" && <DefaultsSection />}
        {activeTab === "api_keys" && <ApiKeysSection />}
        {activeTab === "maintenance" && <Maintenance />}
        {activeTab === "about" && <AboutSection />}
      </main>
    </div>
  );
}
