/**
 * Built-in preset seeding.
 *
 * Seeds 4 default presets on first boot. Each call is idempotent:
 * a preset is only emitted if no preset.created event already exists
 * for that aggregate_id.
 */

import type Database from "better-sqlite3";
import { appendAndProject } from "./projectionRunner.js";
import type { Actor, TaskConfig } from "@shared/events.js";

const SYSTEM_ACTOR: Actor = { kind: "system", component: "scheduler" };

type BuiltinPreset = {
  preset_id: string;
  name: string;
  task_class: string;
  config: TaskConfig;
};

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    preset_id: "preset-default-new-feature",
    name: "Default: New Feature",
    task_class: "new-feature",
    config: {
      phases: [
        {
          name: "implementer",
          enabled: true,
          transport: "claude-code",
          model: "claude-sonnet-4-6",
          prompt_version_id: "default",
          transport_options: {
            kind: "cli",
            bare: true,
            max_turns: 10,
            max_budget_usd: 1,
            permission_mode: "acceptEdits",
          },
          context_policy: {
            symbol_graph_depth: 2,
            include_tests: true,
            include_similar_patterns: false,
            token_budget: 8000,
          },
        },
        {
          name: "auditor",
          enabled: true,
          transport: "anthropic-api",
          model: "claude-opus-4-7",
          prompt_version_id: "auditor-v1",
          transport_options: { kind: "api", max_tokens: 4096 },
          context_policy: {
            symbol_graph_depth: 0,
            include_tests: false,
            include_similar_patterns: false,
            token_budget: 8000,
          },
        },
      ],
      gates: [],
      retry_policy: {
        max_total_attempts: 3,
        on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
        on_test_fail: { strategy: "retry_same", max_attempts: 2 },
        on_audit_reject: "escalate_to_human",
        on_spec_pushback: "pause_and_notify",
      },
    },
  },
  {
    preset_id: "preset-default-bugfix",
    name: "Default: Bug Fix",
    task_class: "bugfix",
    config: {
      phases: [
        {
          name: "test-author",
          enabled: true,
          transport: "claude-code",
          model: "claude-sonnet-4-6",
          prompt_version_id: "default",
          skip_gates: ["test"],
          transport_options: {
            kind: "cli",
            bare: true,
            max_turns: 5,
            max_budget_usd: 0.5,
            permission_mode: "acceptEdits",
          },
          context_policy: {
            symbol_graph_depth: 2,
            include_tests: true,
            include_similar_patterns: false,
            token_budget: 6000,
          },
        },
        {
          name: "implementer",
          enabled: true,
          transport: "claude-code",
          model: "claude-sonnet-4-6",
          prompt_version_id: "default",
          transport_options: {
            kind: "cli",
            bare: true,
            max_turns: 10,
            max_budget_usd: 1,
            permission_mode: "acceptEdits",
          },
          context_policy: {
            symbol_graph_depth: 2,
            include_tests: true,
            include_similar_patterns: false,
            token_budget: 8000,
          },
        },
        {
          name: "auditor",
          enabled: true,
          transport: "anthropic-api",
          model: "claude-opus-4-7",
          prompt_version_id: "auditor-v1",
          transport_options: { kind: "api", max_tokens: 4096 },
          context_policy: {
            symbol_graph_depth: 0,
            include_tests: false,
            include_similar_patterns: false,
            token_budget: 8000,
          },
        },
      ],
      gates: [],
      retry_policy: {
        max_total_attempts: 3,
        on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
        on_test_fail: { strategy: "retry_same", max_attempts: 2 },
        on_audit_reject: "escalate_to_human",
        on_spec_pushback: "pause_and_notify",
      },
    },
  },
  {
    preset_id: "preset-default-refactor",
    name: "Default: Refactor",
    task_class: "refactor",
    config: {
      phases: [
        {
          name: "implementer",
          enabled: true,
          transport: "claude-code",
          model: "claude-sonnet-4-6",
          prompt_version_id: "default",
          transport_options: {
            kind: "cli",
            bare: true,
            max_turns: 15,
            max_budget_usd: 2,
            permission_mode: "acceptEdits",
          },
          context_policy: {
            symbol_graph_depth: 3,
            include_tests: true,
            include_similar_patterns: true,
            token_budget: 12000,
          },
        },
      ],
      gates: [],
      retry_policy: {
        max_total_attempts: 5,
        on_typecheck_fail: { strategy: "retry_with_more_context", max_attempts: 3 },
        on_test_fail: { strategy: "retry_with_more_context", max_attempts: 3 },
        on_audit_reject: "retry_with_more_context",
        on_spec_pushback: "pause_and_notify",
      },
    },
  },
  {
    preset_id: "preset-default-migration",
    name: "Default: Migration",
    task_class: "migration",
    config: {
      phases: [
        {
          name: "implementer",
          enabled: true,
          transport: "claude-code",
          model: "claude-opus-4-7",
          prompt_version_id: "default",
          transport_options: {
            kind: "cli",
            bare: true,
            max_turns: 20,
            max_budget_usd: 5,
            permission_mode: "acceptEdits",
          },
          context_policy: {
            symbol_graph_depth: 3,
            include_tests: true,
            include_similar_patterns: true,
            token_budget: 16000,
          },
        },
        {
          name: "auditor",
          enabled: true,
          transport: "anthropic-api",
          model: "claude-opus-4-7",
          prompt_version_id: "auditor-v1",
          transport_options: { kind: "api", max_tokens: 8192 },
          context_policy: {
            symbol_graph_depth: 0,
            include_tests: false,
            include_similar_patterns: false,
            token_budget: 8000,
          },
        },
      ],
      gates: [],
      retry_policy: {
        max_total_attempts: 4,
        on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
        on_test_fail: { strategy: "retry_same", max_attempts: 2 },
        on_audit_reject: "escalate_to_human",
        on_spec_pushback: "pause_and_notify",
      },
    },
  },
];

/**
 * Seeds the 4 built-in presets on first boot.
 * Idempotent: skips any preset that already has a preset.created event
 * in the event log.
 */
export function seedBuiltinPresets(db: Database.Database): void {
  for (const preset of BUILTIN_PRESETS) {
    const existing = db
      .prepare(
        "SELECT id FROM events WHERE aggregate_id = ? AND type = 'preset.created' LIMIT 1",
      )
      .get(preset.preset_id);
    if (existing) continue;

    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: preset.preset_id,
      actor: SYSTEM_ACTOR,
      payload: {
        preset_id: preset.preset_id,
        name: preset.name,
        task_class: preset.task_class,
        config: preset.config,
      },
    });
  }
}
