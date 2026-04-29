/**
 * Projection REST routes — read-only GET endpoints for every projection.
 *
 * Each route SELECTs from its projection table, parses JSON columns,
 * and returns typed JSON. Missing single resources return 404 with a
 * problem-details body. Tables that don't exist yet (projection not
 * registered) return empty arrays gracefully.
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import type {
  TaskListRow,
  TaskDetailRow,
  PropositionRow,
  AttemptRow,
  ProviderHealthRow,
  PromptVersionRow,
  AbExperimentRow,
  CostRollupRow,
  PresetRow,
  GraphLayoutResponse,
  GraphLayoutNodeInfo,
} from "@shared/projections.js";
import type { TaskConfig, TaskStatus, Transport, PhaseName } from "@shared/events.js";
import { readGraphLayout } from "../graphLayoutStore.js";

// ============================================================================
// Helpers
// ============================================================================

/** Problem-details 404 response. */
function notFound(c: { json: (data: unknown, status: number) => Response }, resource: string, id: string) {
  return c.json(
    { type: "not_found", title: "Not Found", detail: `${resource} '${id}' not found`, status: 404 },
    404,
  );
}

/**
 * Safely query a projection table that may not exist yet.
 * Returns an empty array if the table hasn't been created.
 */
function safeAll<T>(db: Database.Database, sql: string, params: unknown[] = []): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("no such table")) return [];
    throw e;
  }
}

function safeGet<T>(db: Database.Database, sql: string, params: unknown[] = []): T | undefined {
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("no such table")) return undefined;
    throw e;
  }
}

// ============================================================================
// Row parsers — convert raw SQLite rows (JSON text) to typed objects
// ============================================================================

type RawTaskListRow = Omit<TaskListRow, "phase_models" | "auto_merged" | "depends_on" | "blocked"> & {
  phase_models_json: string | null;
  auto_merged: number;
  depends_on_json: string | null;
  blocked: number;
};

function parseTaskListRow(raw: RawTaskListRow): TaskListRow {
  const { phase_models_json, auto_merged: autoMergedInt, depends_on_json, blocked: blockedInt, ...rest } = raw;
  return {
    ...rest,
    phase_models: phase_models_json ? JSON.parse(phase_models_json) : {},
    auto_merged: autoMergedInt === 1,
    depends_on: depends_on_json ? JSON.parse(depends_on_json) : [],
    blocked: blockedInt === 1,
  };
}

type RawTaskDetailRow = {
  task_id: string;
  prd_id: string | null;
  title: string;
  status: string;
  config_json: string;
  preset_id: string | null;
  preset_override_keys_json: string;
  proposition_ids_json: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  current_attempt_id: string | null;
  last_event_id: string;
  updated_at: string;
};

function parseTaskDetailRow(raw: RawTaskDetailRow): TaskDetailRow {
  return {
    task_id: raw.task_id,
    prd_id: raw.prd_id ?? undefined,
    title: raw.title,
    status: raw.status as TaskStatus,
    config: JSON.parse(raw.config_json) as TaskConfig,
    preset_id: raw.preset_id ?? undefined,
    preset_override_keys: JSON.parse(raw.preset_override_keys_json) as string[],
    proposition_ids: JSON.parse(raw.proposition_ids_json) as string[],
    worktree_path: raw.worktree_path ?? undefined,
    worktree_branch: raw.worktree_branch ?? undefined,
    current_attempt_id: raw.current_attempt_id ?? undefined,
    last_event_id: raw.last_event_id,
    updated_at: raw.updated_at,
  };
}

type RawPropositionRow = {
  proposition_id: string;
  prd_id: string;
  text: string;
  source_section: string;
  source_line_start: number;
  source_line_end: number;
  confidence: number;
  task_id: string | null;
  active_pushback_ids_json: string | null;
  updated_at: string;
};

function parsePropositionRow(raw: RawPropositionRow): PropositionRow {
  return {
    proposition_id: raw.proposition_id,
    prd_id: raw.prd_id,
    text: raw.text,
    source_span: {
      section: raw.source_section,
      line_start: raw.source_line_start,
      line_end: raw.source_line_end,
    },
    confidence: raw.confidence,
    task_id: raw.task_id ?? undefined,
    active_pushback_ids: raw.active_pushback_ids_json ? JSON.parse(raw.active_pushback_ids_json) : [],
    updated_at: raw.updated_at,
  };
}

type RawAttemptRow = {
  attempt_id: string;
  task_id: string;
  attempt_number: number;
  status: string;
  outcome: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  tokens_in_total: number;
  tokens_out_total: number;
  cost_usd_total: number;
  phases_json: string;
  gate_runs_json: string;
  audit_json: string | null;
  files_changed_json: string;
  config_snapshot_json: string;
  previous_attempt_id: string | null;
  commit_sha: string | null;
  empty: number | null;
  effective_diff_attempt_id: string | null;
  last_failure_reason: string | null;
  last_event_id: string;
};

function parseAttemptRow(raw: RawAttemptRow): AttemptRow {
  return {
    attempt_id: raw.attempt_id,
    task_id: raw.task_id,
    attempt_number: raw.attempt_number,
    status: raw.status as AttemptRow["status"],
    outcome: (raw.outcome ?? undefined) as AttemptRow["outcome"],
    started_at: raw.started_at,
    completed_at: raw.completed_at ?? undefined,
    duration_ms: raw.duration_ms ?? undefined,
    tokens_in_total: raw.tokens_in_total,
    tokens_out_total: raw.tokens_out_total,
    cost_usd_total: raw.cost_usd_total,
    phases: JSON.parse(raw.phases_json),
    gate_runs: JSON.parse(raw.gate_runs_json),
    audit: raw.audit_json ? JSON.parse(raw.audit_json) : undefined,
    files_changed: JSON.parse(raw.files_changed_json),
    config_snapshot: JSON.parse(raw.config_snapshot_json),
    previous_attempt_id: raw.previous_attempt_id ?? undefined,
    commit_sha: raw.commit_sha ?? undefined,
    empty: raw.empty != null ? Boolean(raw.empty) : undefined,
    effective_diff_attempt_id: raw.effective_diff_attempt_id ?? undefined,
    last_failure_reason: raw.last_failure_reason ?? null,
    last_event_id: raw.last_event_id,
  };
}

type RawProviderHealthRow = {
  provider_id: string;
  transport: string;
  status: string;
  latency_ms: number | null;
  last_probe_at: string | null;
  last_error: string | null;
  models_json: string | null;
  binary_path: string | null;
  endpoint: string | null;
  auth_method: string | null;
  auth_present: number;
};

function parseProviderHealthRow(raw: RawProviderHealthRow): ProviderHealthRow {
  return {
    provider_id: raw.provider_id,
    transport: raw.transport as Transport,
    status: raw.status as ProviderHealthRow["status"],
    latency_ms: raw.latency_ms ?? undefined,
    last_probe_at: raw.last_probe_at ?? undefined,
    last_error: raw.last_error ?? undefined,
    models: raw.models_json ? JSON.parse(raw.models_json) : undefined,
    binary_path: raw.binary_path ?? undefined,
    endpoint: raw.endpoint ?? undefined,
    auth_method: (raw.auth_method ?? undefined) as ProviderHealthRow["auth_method"],
    auth_present: raw.auth_present === 1,
  };
}

type RawPromptVersionRow = {
  prompt_version_id: string;
  name: string;
  phase_class: string;
  template_hash: string;
  parent_version_id: string | null;
  notes: string | null;
  retired: number;
  invocations_last_30d: number;
  success_rate_last_30d: number | null;
  avg_cost_usd: number | null;
  ab_experiment_ids_json: string | null;
  created_at: string;
};

function parsePromptVersionRow(raw: RawPromptVersionRow): PromptVersionRow {
  return {
    prompt_version_id: raw.prompt_version_id,
    name: raw.name,
    phase_class: raw.phase_class as PhaseName,
    template_hash: raw.template_hash,
    parent_version_id: raw.parent_version_id ?? undefined,
    notes: raw.notes ?? undefined,
    retired: raw.retired === 1,
    invocations_last_30d: raw.invocations_last_30d,
    success_rate_last_30d: raw.success_rate_last_30d ?? undefined,
    avg_cost_usd: raw.avg_cost_usd ?? undefined,
    ab_experiment_ids: raw.ab_experiment_ids_json ? JSON.parse(raw.ab_experiment_ids_json) : [],
    created_at: raw.created_at,
  };
}

type RawAbExperimentRow = {
  experiment_id: string;
  phase_class: string;
  variant_a_id: string;
  variant_b_id: string;
  bucket_key: string;
  split_a: number;
  a_n: number;
  a_success_n: number;
  a_cost_usd: number;
  b_n: number;
  b_success_n: number;
  b_cost_usd: number;
  a_success_rate: number;
  b_success_rate: number;
  significance_p: number | null;
  status: string;
  winner: string | null;
};

function parseAbExperimentRow(raw: RawAbExperimentRow): AbExperimentRow {
  return {
    experiment_id: raw.experiment_id,
    phase_class: raw.phase_class as PhaseName,
    variant_a_id: raw.variant_a_id,
    variant_b_id: raw.variant_b_id,
    bucket_key: raw.bucket_key,
    split_a: raw.split_a,
    a_n: raw.a_n,
    a_success_n: raw.a_success_n,
    a_cost_usd: raw.a_cost_usd,
    b_n: raw.b_n,
    b_success_n: raw.b_success_n,
    b_cost_usd: raw.b_cost_usd,
    a_success_rate: raw.a_success_rate,
    b_success_rate: raw.b_success_rate,
    significance_p: raw.significance_p ?? undefined,
    status: raw.status as AbExperimentRow["status"],
    winner: (raw.winner ?? undefined) as AbExperimentRow["winner"],
  };
}

type RawPresetRow = {
  preset_id: string;
  name: string;
  task_class: string;
  config_json: string;
  updated_at: string;
};

function parsePresetRow(raw: RawPresetRow): PresetRow {
  return {
    preset_id: raw.preset_id,
    name: raw.name,
    task_class: raw.task_class,
    config: JSON.parse(raw.config_json),
    updated_at: raw.updated_at,
  };
}

// ============================================================================
// Route factory
// ============================================================================

export function createProjectionRoutes(db: Database.Database): Hono {
  const routes = new Hono();

  // -- task_list: ordered by updated_at DESC, optional ?prd_id and ?status
  routes.get("/api/projections/task_list", (c) => {
    const prdId = c.req.query("prd_id");
    const status = c.req.query("status");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (prdId) {
      conditions.push("prd_id = ?");
      params.push(prdId);
    }
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = safeAll<RawTaskListRow>(
      db,
      `SELECT * FROM proj_task_list ${where} ORDER BY updated_at DESC`,
      params,
    );

    return c.json(rows.map(parseTaskListRow));
  });

  // -- archived tasks: task_detail rows with status = 'archived'
  routes.get("/api/projections/archived_tasks", (c) => {
    const rows = safeAll<RawTaskDetailRow>(
      db,
      "SELECT * FROM proj_task_detail WHERE status = 'archived' ORDER BY updated_at DESC",
    );
    return c.json(rows.map(parseTaskDetailRow));
  });

  // -- task_detail/:task_id
  routes.get("/api/projections/task_detail/:task_id", (c) => {
    const taskId = c.req.param("task_id");
    const raw = safeGet<RawTaskDetailRow>(
      db,
      "SELECT * FROM proj_task_detail WHERE task_id = ?",
      [taskId],
    );

    if (!raw) return notFound(c, "task_detail", taskId);
    return c.json(parseTaskDetailRow(raw));
  });

  // -- proposition?prd_id= or proposition?ids=PROP-1,PROP-2
  routes.get("/api/projections/proposition", (c) => {
    const prdId = c.req.query("prd_id");
    const ids = c.req.query("ids");

    let where = "";
    let params: string[] = [];

    if (ids) {
      const idList = ids.split(",").filter(Boolean);
      if (idList.length > 0) {
        where = `WHERE proposition_id IN (${idList.map(() => "?").join(",")})`;
        params = idList;
      }
    } else if (prdId) {
      where = "WHERE prd_id = ?";
      params = [prdId];
    }

    const rows = safeAll<RawPropositionRow>(
      db,
      `SELECT * FROM proj_proposition ${where} ORDER BY proposition_id ASC`,
      params,
    );

    return c.json(rows.map(parsePropositionRow));
  });

  // -- attempt/:attempt_id
  routes.get("/api/projections/attempt/:attempt_id", (c) => {
    const attemptId = c.req.param("attempt_id");
    const raw = safeGet<RawAttemptRow>(
      db,
      "SELECT * FROM proj_attempt WHERE attempt_id = ?",
      [attemptId],
    );

    if (!raw) return notFound(c, "attempt", attemptId);
    return c.json(parseAttemptRow(raw));
  });

  // -- attempts?task_id= (summaries ordered by attempt_number DESC)
  routes.get("/api/projections/attempts", (c) => {
    const taskId = c.req.query("task_id");
    const where = taskId ? "WHERE task_id = ?" : "";
    const params = taskId ? [taskId] : [];

    const rows = safeAll<RawAttemptRow>(
      db,
      `SELECT * FROM proj_attempt ${where} ORDER BY attempt_number DESC`,
      params,
    );

    return c.json(rows.map(parseAttemptRow));
  });

  // -- provider_health
  routes.get("/api/projections/provider_health", (c) => {
    const rows = safeAll<RawProviderHealthRow>(
      db,
      "SELECT * FROM proj_provider_health ORDER BY provider_id ASC",
    );

    return c.json(rows.map(parseProviderHealthRow));
  });

  // -- prompt_library?phase_class=
  routes.get("/api/projections/prompt_library", (c) => {
    const phaseClass = c.req.query("phase_class");
    const where = phaseClass ? "WHERE phase_class = ?" : "";
    const params = phaseClass ? [phaseClass] : [];

    const rows = safeAll<RawPromptVersionRow>(
      db,
      `SELECT * FROM proj_prompt_library ${where} ORDER BY created_at DESC`,
      params,
    );

    return c.json(rows.map(parsePromptVersionRow));
  });

  // -- prompt_template/:id — fetch the raw template text for a prompt version
  routes.get("/api/projections/prompt_template/:id", (c) => {
    const pvId = c.req.param("id");
    const row = db
      .prepare(
        "SELECT payload_json FROM events WHERE type = 'prompt_version.created' AND aggregate_id = ? LIMIT 1",
      )
      .get(pvId) as { payload_json: string } | undefined;

    if (!row) {
      return c.json({ error: "Prompt version not found" }, 404);
    }

    const payload = JSON.parse(row.payload_json) as { template: string };
    return c.json({ template: payload.template });
  });

  // -- ab_experiment?phase_class=
  routes.get("/api/projections/ab_experiment", (c) => {
    const phaseClass = c.req.query("phase_class");
    const where = phaseClass ? "WHERE phase_class = ?" : "";
    const params = phaseClass ? [phaseClass] : [];

    const rows = safeAll<RawAbExperimentRow>(
      db,
      `SELECT * FROM proj_ab_experiment ${where} ORDER BY experiment_id DESC`,
      params,
    );

    return c.json(rows.map(parseAbExperimentRow));
  });

  // -- cost_rollup?from=&to=&group_by=
  routes.get("/api/projections/cost_rollup", (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const groupBy = c.req.query("group_by");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (from) {
      conditions.push("date >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("date <= ?");
      params.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // group_by determines the SELECT granularity
    if (groupBy === "provider") {
      const rows = safeAll<{ provider_id: string; invocation_count: number; tokens_in: number; tokens_out: number; cost_usd: number }>(
        db,
        `SELECT provider_id, SUM(invocation_count) as invocation_count, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out, SUM(cost_usd) as cost_usd
         FROM proj_cost_rollup ${where} GROUP BY provider_id ORDER BY cost_usd DESC`,
        params,
      );
      return c.json(rows);
    }

    if (groupBy === "model") {
      const rows = safeAll<{ provider_id: string; model: string; invocation_count: number; tokens_in: number; tokens_out: number; cost_usd: number }>(
        db,
        `SELECT provider_id, model, SUM(invocation_count) as invocation_count, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out, SUM(cost_usd) as cost_usd
         FROM proj_cost_rollup ${where} GROUP BY provider_id, model ORDER BY cost_usd DESC`,
        params,
      );
      return c.json(rows);
    }

    // Default: return raw daily rows
    const rows = safeAll<CostRollupRow>(
      db,
      `SELECT * FROM proj_cost_rollup ${where} ORDER BY date DESC`,
      params,
    );
    return c.json(rows);
  });

  // -- preset?task_class=
  routes.get("/api/projections/preset", (c) => {
    const taskClass = c.req.query("task_class");
    const where = taskClass ? "WHERE task_class = ?" : "";
    const params = taskClass ? [taskClass] : [];

    const rows = safeAll<RawPresetRow>(
      db,
      `SELECT * FROM proj_preset ${where} ORDER BY name ASC`,
      params,
    );

    return c.json(rows.map(parsePresetRow));
  });

  // -- graph_layout: dependency graph with node positions and task metadata
  routes.get("/api/projections/graph_layout", (c) => {
    const layout = readGraphLayout(db);
    if (!layout) return c.json({ nodes: {}, edges: [], meta: { critical_path: [], direction: "DOWN" } } satisfies GraphLayoutResponse);

    const prdId = c.req.query("prd_id");

    // Fetch task metadata to enrich nodes with title, status, attempt_count, max_total_attempts
    const taskRows = safeAll<{ task_id: string; title: string; status: string; attempt_count: number; prd_id: string | null; config_json: string | null }>(
      db,
      `SELECT tl.task_id, tl.title, tl.status, tl.attempt_count, tl.prd_id, td.config_json
       FROM proj_task_list tl
       LEFT JOIN proj_task_detail td ON tl.task_id = td.task_id`,
    );
    const taskMap = new Map(taskRows.map((r) => [r.task_id, r]));

    // Build enriched nodes, optionally filtering by prd_id
    const nodes: Record<string, GraphLayoutNodeInfo> = {};
    for (const [taskId, pos] of Object.entries(layout.nodes)) {
      const task = taskMap.get(taskId);
      if (!task) continue;
      if (prdId === "standalone" && task.prd_id != null) continue;
      if (prdId && prdId !== "standalone" && task.prd_id !== prdId) continue;
      nodes[taskId] = {
        x: pos.x,
        y: pos.y,
        width: pos.width,
        height: pos.height,
        title: task.title,
        status: task.status as TaskStatus,
        attempt_count: task.attempt_count,
        max_total_attempts: task.config_json ? (JSON.parse(task.config_json) as TaskConfig).retry_policy.max_total_attempts : 3,
        prd_id: task.prd_id ?? undefined,
      };
    }

    // Filter edges to only include those between included nodes
    const edges = layout.edges.filter((e) => e.source in nodes && e.target in nodes);

    // Filter critical path to included nodes
    const critical_path = layout.meta.critical_path.filter((id) => id in nodes);

    const response: GraphLayoutResponse = {
      nodes,
      edges,
      meta: { critical_path, direction: layout.meta.direction },
    };

    return c.json(response);
  });

  return routes;
}
