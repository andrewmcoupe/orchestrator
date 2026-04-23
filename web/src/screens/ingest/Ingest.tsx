// @ts-check
import { useState, useCallback } from "react";
import { ArrowLeft, RefreshCw, CheckCircle, AlertCircle, HelpCircle, FileText } from "lucide-react";
import type { PropositionRow } from "@shared/projections.js";
import type { AnyEvent } from "@shared/events.js";

// ============================================================================
// Types
// ============================================================================

type TaskDraftSummary = {
  task_id: string;
  title: string;
  proposition_ids: string[];
};

type IngestResult = {
  prd_id: string;
  propositions: PropositionRow[];
  draft_tasks: TaskDraftSummary[];
  pushback_count: number;
};

type PushbackData = {
  pushback_id: string;
  proposition_id: string;
  kind: "blocking" | "advisory" | "question";
  rationale: string;
  suggested_resolutions: string[];
};

type IngestPhase =
  | { phase: "idle" }
  | { phase: "loading"; path: string }
  | { phase: "review"; result: IngestResult; pushbacks: PushbackData[]; path: string };

type PushbackResolution = "reply_inline" | "amended" | "deferred";

// ============================================================================
// Helpers
// ============================================================================

const PUSHBACK_PILL: Record<PushbackData["kind"], { label: string; cls: string; icon: React.ReactNode }> = {
  blocking: {
    label: "blocking",
    cls: "bg-status-danger/10 text-status-danger border-status-danger/30",
    icon: <AlertCircle size={11} />,
  },
  advisory: {
    label: "advisory",
    cls: "bg-status-warning/10 text-status-warning border-status-warning/30",
    icon: <AlertCircle size={11} />,
  },
  question: {
    label: "question",
    cls: "bg-bg-tertiary text-text-secondary border-border-default",
    icon: <HelpCircle size={11} />,
  },
};

function confidenceBar(confidence: number) {
  const pct = Math.round(confidence * 100);
  const colour =
    pct >= 80 ? "bg-status-healthy" : pct >= 50 ? "bg-status-warning" : "bg-status-danger";
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 w-16 rounded-full bg-bg-tertiary overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-text-tertiary font-mono">{pct}%</span>
    </div>
  );
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

// ============================================================================
// PropositionCard — displays a single proposition with optional pushback
// ============================================================================

type PropositionCardProps = {
  proposition: PropositionRow;
  pushbacks: PushbackData[];
  onResolvePushback: (
    pushbackId: string,
    resolution: PushbackResolution,
    text?: string,
  ) => Promise<void>;
};

function PropositionCard({ proposition, pushbacks, onResolvePushback }: PropositionCardProps) {
  const hasBlockingPushback = pushbacks.some((p) => p.kind === "blocking");

  return (
    <div
      className={`border p-3 ${
        hasBlockingPushback ? "border-status-danger/30 bg-status-danger/5" : "border-border-muted bg-bg-secondary"
      }`}
    >
      {/* Proposition header */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-text-tertiary">{proposition.proposition_id.slice(0, 14)}</span>
          <span
            className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium border ${
              hasBlockingPushback
                ? "bg-status-danger/10 text-status-danger border-status-danger/30"
                : "bg-status-healthy/10 text-status-healthy border-status-healthy/30"
            }`}
          >
            {hasBlockingPushback ? "blocked" : "ready"}
          </span>
          <span className="text-[10px] text-text-tertiary font-mono">
            {proposition.source_span.section} L{proposition.source_span.line_start}–{proposition.source_span.line_end}
          </span>
        </div>
        {confidenceBar(proposition.confidence)}
      </div>

      {/* Proposition text */}
      <p className="text-sm text-text-primary leading-relaxed">{proposition.text}</p>

      {/* Pushback blocks */}
      {pushbacks.map((pb) => (
        <PushbackBlock
          key={pb.pushback_id}
          pushback={pb}
          onResolve={(resolution, text) => onResolvePushback(pb.pushback_id, resolution, text)}
        />
      ))}
    </div>
  );
}

// ============================================================================
// PushbackBlock — inline pushback with resolution actions
// ============================================================================

type PushbackBlockProps = {
  pushback: PushbackData;
  onResolve: (resolution: PushbackResolution, text?: string) => Promise<void>;
};

function PushbackBlock({ pushback, onResolve }: PushbackBlockProps) {
  const [resolving, setResolving] = useState<PushbackResolution | null>(null);
  const [resolved, setResolved] = useState(false);
  const [amendText, setAmendText] = useState("");
  const [replyText, setReplyText] = useState("");
  const pill = PUSHBACK_PILL[pushback.kind];

  const handleResolve = useCallback(
    async (resolution: PushbackResolution) => {
      const text = resolution === "amended" ? amendText : resolution === "reply_inline" ? replyText : undefined;
      setResolving(resolution);
      await onResolve(resolution, text);
      setResolved(true);
    },
    [onResolve, amendText, replyText],
  );

  if (resolved) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-status-healthy">
        <CheckCircle size={12} />
        <span>Pushback resolved</span>
      </div>
    );
  }

  return (
    <div className={`mt-2.5 border p-2.5 ${pill.cls}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        {pill.icon}
        <span className={`text-[10px] font-medium uppercase tracking-wider`}>{pill.label} pushback</span>
      </div>
      <p className="text-xs leading-relaxed mb-2">{pushback.rationale}</p>

      {pushback.suggested_resolutions.length > 0 && (
        <ul className="mb-2 space-y-0.5">
          {pushback.suggested_resolutions.map((r, i) => (
            <li key={i} className="text-[11px] text-text-secondary flex gap-1.5">
              <span className="text-text-tertiary mt-0.5">→</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Inline reply/amend inputs */}
      {resolving === "reply_inline" && (
        <div className="mb-2">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Type your reply…"
            rows={2}
            className="w-full border border-border-default bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary outline-none resize-none focus:border-status-warning"
          />
        </div>
      )}
      {resolving === "amended" && (
        <div className="mb-2">
          <textarea
            value={amendText}
            onChange={(e) => setAmendText(e.target.value)}
            placeholder="Amended proposition text…"
            rows={2}
            className="w-full border border-border-default bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary outline-none resize-none focus:border-status-warning"
          />
        </div>
      )}

      <div className="flex gap-1.5 flex-wrap">
        {resolving === "reply_inline" ? (
          <button
            type="button"
            onClick={() => handleResolve("reply_inline")}
            disabled={!replyText.trim()}
            className="px-2.5 py-1 text-[11px] font-medium bg-bg-inverse text-text-inverse hover:opacity-80 transition-opacity disabled:opacity-40 cursor-pointer disabled:cursor-default"
          >
            Submit reply
          </button>
        ) : resolving === "amended" ? (
          <button
            type="button"
            onClick={() => handleResolve("amended")}
            disabled={!amendText.trim()}
            className="px-2.5 py-1 text-[11px] font-medium bg-bg-inverse text-text-inverse hover:opacity-80 transition-opacity disabled:opacity-40 cursor-pointer disabled:cursor-default"
          >
            Save amendment
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setResolving("reply_inline")}
              className="px-2.5 py-1 text-[11px] font-medium border border-current hover:bg-white/10 transition-colors cursor-pointer"
            >
              Reply inline
            </button>
            <button
              type="button"
              onClick={() => setResolving("amended")}
              className="px-2.5 py-1 text-[11px] font-medium border border-current hover:bg-white/10 transition-colors cursor-pointer"
            >
              Amend
            </button>
            <button
              type="button"
              onClick={() => handleResolve("deferred")}
              className="px-2.5 py-1 text-[11px] font-medium hover:bg-white/10 transition-colors cursor-pointer opacity-70"
            >
              Defer
            </button>
          </>
        )}
        {resolving && (
          <button
            type="button"
            onClick={() => setResolving(null)}
            className="px-2.5 py-1 text-[11px] opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// DraftTaskCard — a grouped set of propositions with pushback handling
// ============================================================================

type DraftTaskCardProps = {
  draft: TaskDraftSummary;
  propositions: PropositionRow[];
  pushbacksByProp: Map<string, PushbackData[]>;
  onResolvePushback: (pbId: string, res: PushbackResolution, text?: string) => Promise<void>;
};

function DraftTaskCard({ draft, propositions, pushbacksByProp, onResolvePushback }: DraftTaskCardProps) {
  const taskPropositions = draft.proposition_ids
    .map((id) => propositions.find((p) => p.proposition_id === id))
    .filter((p): p is PropositionRow => p !== undefined);

  const isBlocked = taskPropositions.some(
    (p) => (pushbacksByProp.get(p.proposition_id) ?? []).some((pb) => pb.kind === "blocking"),
  );

  return (
    <div className={`border p-4 ${isBlocked ? "border-status-danger/40" : "border-border-default"}`}>
      {/* Card header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${
              isBlocked
                ? "bg-status-danger/10 text-status-danger border-status-danger/30"
                : "bg-status-healthy/10 text-status-healthy border-status-healthy/30"
            }`}
          >
            {isBlocked ? "blocked by pushback" : "ready"}
          </span>
          <span className="font-mono text-[10px] text-text-tertiary">{draft.task_id.slice(0, 16)}</span>
        </div>
        <span className="text-[10px] text-text-tertiary">{taskPropositions.length} prop{taskPropositions.length !== 1 ? "s" : ""}</span>
      </div>

      <h3 className="text-base font-semibold text-text-primary mb-3">{draft.title}</h3>

      {/* Propositions */}
      <div className="space-y-2">
        {taskPropositions.map((prop) => (
          <PropositionCard
            key={prop.proposition_id}
            proposition={prop}
            pushbacks={pushbacksByProp.get(prop.proposition_id) ?? []}
            onResolvePushback={onResolvePushback}
          />
        ))}
        {taskPropositions.length === 0 && (
          <p className="text-xs text-text-tertiary italic">No propositions linked.</p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main Ingest component
// ============================================================================

type IngestProps = {
  /** Navigate back to tasks screen */
  onBack: () => void;
};

export function Ingest({ onBack }: IngestProps) {
  const [state, setState] = useState<IngestPhase>({ phase: "idle" });
  const [pathInput, setPathInput] = useState("");
  const [prdContent, setPrdContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  // Track which pushbacks have been resolved locally (for re-ingest recovery)
  const [resolvedPushbacks, setResolvedPushbacks] = useState<Set<string>>(new Set());

  // --------------------------------------------------------------------------
  // Ingest action
  // --------------------------------------------------------------------------

  const handleIngest = useCallback(async (path: string, content?: string) => {
    if (!path.trim() && !content?.trim()) return;
    setError(null);
    setState({ phase: "loading", path });

    try {
      // 1. Call ingest command
      const body = content?.trim()
        ? JSON.stringify({ content: content.trim() })
        : JSON.stringify({ path: path.trim() });
      const ingestRes = await fetch("/api/commands/prd/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!ingestRes.ok) {
        const err = await ingestRes.json().catch(() => ({ error: "Ingest failed" }));
        throw new Error((err as { error?: string }).error ?? "Ingest failed");
      }

      const result = (await ingestRes.json()) as IngestResult;

      // 2. Fetch pushback event details via correlation_id
      const eventsRes = await fetch(
        `/api/events/recent?correlation_id=${encodeURIComponent(result.prd_id)}&limit=200`,
      );
      const events: AnyEvent[] = eventsRes.ok ? ((await eventsRes.json()) as AnyEvent[]) : [];

      const pushbacks: PushbackData[] = events
        .filter((e): e is AnyEvent & { type: "pushback.raised" } => e.type === "pushback.raised")
        .map((e) => ({
          pushback_id: e.payload.pushback_id,
          proposition_id: e.payload.proposition_id,
          kind: e.payload.kind,
          rationale: e.payload.rationale,
          suggested_resolutions: e.payload.suggested_resolutions,
        }));

      setState({ phase: "review", result, pushbacks, path });
      setResolvedPushbacks(new Set());
    } catch (err) {
      setError((err as Error).message);
      setState({ phase: "idle" });
    }
  }, []);

  // --------------------------------------------------------------------------
  // Pushback resolution
  // --------------------------------------------------------------------------

  const handleResolvePushback = useCallback(
    async (pushbackId: string, resolution: PushbackResolution, text?: string) => {
      const body: Record<string, unknown> = { resolution };
      if (text && resolution === "amended") body.amended_proposition_text = text;
      if (text && resolution === "reply_inline") body.resolution_text = text;

      await fetch(`/api/commands/pushback/${pushbackId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setResolvedPushbacks((prev) => new Set([...prev, pushbackId]));
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Accept — create tasks from draft summaries
  // --------------------------------------------------------------------------

  const handleAccept = useCallback(async () => {
    if (state.phase !== "review") return;
    setAccepting(true);

    for (const draft of state.result.draft_tasks) {
      await fetch("/api/commands/task/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          proposition_ids: draft.proposition_ids,
        }),
      });
    }

    onBack();
  }, [state, onBack]);

  // --------------------------------------------------------------------------
  // Render: Idle — path input form
  // --------------------------------------------------------------------------

  if (state.phase === "idle" || state.phase === "loading") {
    const isLoading = state.phase === "loading";
    return (
      <div className="flex flex-col h-full">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border-muted">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          >
            <ArrowLeft size={15} />
            <span>Tasks</span>
          </button>
          <span className="text-text-tertiary">/</span>
          <span className="text-sm font-semibold text-text-primary">Ingest PRD</span>
        </div>

        {/* Form */}
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-lg px-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="flex h-10 w-10 items-center justify-center bg-bg-tertiary">
                <FileText size={20} className="text-text-secondary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Ingest a PRD</h2>
                <p className="text-sm text-text-secondary">
                  Enter the server-side path to your PRD markdown file.
                </p>
              </div>
            </div>

            {error && (
              <div className="mb-4 border border-status-danger/30 bg-status-danger/5 px-4 py-3">
                <p className="text-sm text-status-danger">{error}</p>
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="prd-content" className="block text-xs font-medium text-text-secondary mb-1.5">
                Paste PRD content
              </label>
              <textarea
                id="prd-content"
                value={prdContent}
                onChange={(e) => setPrdContent(e.target.value)}
                placeholder="Paste your PRD markdown here…"
                disabled={isLoading}
                rows={6}
                className="w-full border border-border-default bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-secondary transition-colors resize-y disabled:opacity-50"
              />
            </div>

            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px bg-border-muted" />
              <span className="text-xs text-text-tertiary">or</span>
              <div className="flex-1 h-px bg-border-muted" />
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isLoading) void handleIngest(pathInput, prdContent);
                }}
                placeholder="/absolute/path/to/your-prd.md"
                disabled={isLoading}
                className="flex-1 border border-border-default bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-secondary transition-colors font-mono disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void handleIngest(pathInput, prdContent)}
                disabled={isLoading || (!pathInput.trim() && !prdContent.trim())}
                className="border border-transparent bg-bg-inverse px-5 py-2.5 text-sm font-medium text-text-inverse hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer disabled:cursor-default"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <RefreshCw size={14} className="animate-spin" />
                    Ingesting…
                  </span>
                ) : (
                  "Ingest"
                )}
              </button>
            </div>

            {isLoading && (
              <p className="mt-3 text-xs text-text-tertiary text-center">
                Extracting propositions from {fileName(state.path)} via Anthropic API…
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Review
  // --------------------------------------------------------------------------

  if (state.phase !== "review") return null;
  const { result, pushbacks, path } = state;
  const isAccepting = accepting;

  // Build pushbacks by proposition_id, filtering out resolved ones
  const pushbacksByProp = new Map<string, PushbackData[]>();
  for (const pb of pushbacks) {
    if (resolvedPushbacks.has(pb.pushback_id)) continue;
    const existing = pushbacksByProp.get(pb.proposition_id) ?? [];
    existing.push(pb);
    pushbacksByProp.set(pb.proposition_id, existing);
  }

  // Ungrouped propositions (not referenced by any draft task)
  const assignedPropIds = new Set(result.draft_tasks.flatMap((t) => t.proposition_ids));
  const ungrouped = result.propositions.filter((p) => !assignedPropIds.has(p.proposition_id));

  // Active (unresolved) blocking pushback count
  const activeBlockingCount = pushbacks.filter(
    (pb) => pb.kind === "blocking" && !resolvedPushbacks.has(pb.pushback_id),
  ).length;

  const fileSizeKb = (result.propositions.length > 0
    ? result.propositions.reduce((acc, p) => acc + p.text.length, 0) / 1024
    : 0
  ).toFixed(1);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4 px-6 py-3.5 border-b border-border-muted bg-bg-primary shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer shrink-0"
          >
            <ArrowLeft size={15} />
            <span>Tasks</span>
          </button>
          <span className="text-text-tertiary">/</span>
          <span className="text-sm font-semibold text-text-primary truncate">
            Ingest PRD &middot; {fileName(path)}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void handleIngest(path)}
            className="flex items-center gap-1.5 border border-border-default px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors cursor-pointer"
          >
            <RefreshCw size={13} />
            Regenerate
          </button>
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={isAccepting || activeBlockingCount > 0}
            className="bg-bg-inverse px-4 py-1.5 text-sm font-medium text-text-inverse hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer disabled:cursor-default"
            title={activeBlockingCount > 0 ? `Resolve ${activeBlockingCount} blocking pushback(s) first` : undefined}
          >
            {isAccepting ? (
              <span className="flex items-center gap-1.5">
                <RefreshCw size={13} className="animate-spin" />
                Creating…
              </span>
            ) : (
              `Accept & create ${result.draft_tasks.length} task${result.draft_tasks.length !== 1 ? "s" : ""}`
            )}
          </button>
        </div>
      </div>

      {/* Meta strip */}
      <div className="flex items-center gap-5 px-6 py-2.5 border-b border-border-muted bg-bg-secondary text-[11px] text-text-secondary shrink-0">
        <span className="font-mono">{fileSizeKb} KB est.</span>
        <span>·</span>
        <span>model: <span className="font-mono text-text-primary">claude-sonnet-4-6</span></span>
        <span>·</span>
        <span>prompt: <span className="font-mono text-text-primary">ingest-v1</span></span>
        <span>·</span>
        <span className="text-text-primary font-medium">{result.propositions.length} propositions</span>
        {pushbacks.length > 0 && (
          <>
            <span>·</span>
            <span className={activeBlockingCount > 0 ? "text-status-danger font-medium" : "text-text-secondary"}>
              {activeBlockingCount} flagged
            </span>
          </>
        )}
        <span className="ml-auto">
          <span className="font-mono text-text-tertiary">{result.prd_id}</span>
        </span>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {/* Draft task cards */}
        {result.draft_tasks.map((draft) => (
          <DraftTaskCard
            key={draft.task_id}
            draft={draft}
            propositions={result.propositions}
            pushbacksByProp={pushbacksByProp}
            onResolvePushback={handleResolvePushback}
          />
        ))}

        {/* Ungrouped propositions */}
        {ungrouped.length > 0 && (
          <div className="border border-dashed border-border-default p-4">
            <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-3 font-medium">
              Ungrouped Propositions ({ungrouped.length})
            </h3>
            <div className="space-y-2">
              {ungrouped.map((prop) => (
                <PropositionCard
                  key={prop.proposition_id}
                  proposition={prop}
                  pushbacks={pushbacksByProp.get(prop.proposition_id) ?? []}
                  onResolvePushback={handleResolvePushback}
                />
              ))}
            </div>
          </div>
        )}

        {result.draft_tasks.length === 0 && ungrouped.length === 0 && (
          <div className="text-center py-12">
            <p className="text-sm text-text-tertiary">No propositions extracted. Try regenerating.</p>
          </div>
        )}
      </div>
    </div>
  );
}
