/**
 * Gemini stream-json event mapper.
 *
 * Translates decoded GeminiStreamEvents into AppendEventInput arrays,
 * buffering assistant delta messages until a flush is triggered.
 */

import type { AppendEventInput } from "../../eventStore.js";
import type { GeminiStreamEvent } from "./schema.js";

// ============================================================================
// State
// ============================================================================

export interface MapperState {
  readonly assistantBuffer: string;
  readonly seenResult: boolean;
  readonly session_id?: string;
  /** Captured stats from the result event — used by the adapter to build the
   *  final invocation.completed event together with stdout/stderr tail hashes. */
  readonly result?: {
    readonly outcome: "success" | "failed";
    readonly tokens_in: number;
    readonly tokens_out: number;
    readonly duration_ms: number;
  };
  /** Invocation context — set once at creation, threaded through unchanged. */
  readonly invocation_id: string;
  readonly attempt_id: string;
  readonly phase_name: string;
  readonly prompt_version_id: string;
  readonly context_manifest_hash: string;
}

export function createInitialState(opts: {
  invocation_id: string;
  attempt_id: string;
  phase_name: string;
  prompt_version_id: string;
  context_manifest_hash: string;
}): MapperState {
  return {
    assistantBuffer: "",
    seenResult: false,
    ...opts,
  };
}

// ============================================================================
// Mapper
// ============================================================================

export function mapEvent(
  event: GeminiStreamEvent,
  state: MapperState,
): { state: MapperState; emit: ReadonlyArray<AppendEventInput> } {
  const base = {
    aggregate_type: "attempt" as const,
    aggregate_id: state.attempt_id,
    actor: {
      kind: "cli" as const,
      transport: "gemini-cli" as const,
      invocation_id: state.invocation_id,
    },
    correlation_id: state.attempt_id,
  };

  // ── init ──────────────────────────────────────────────────────────────
  if (event.type === "init") {
    const input: AppendEventInput<"invocation.started"> = {
      ...base,
      type: "invocation.started",
      payload: {
        invocation_id: state.invocation_id,
        attempt_id: state.attempt_id,
        phase_name: state.phase_name,
        transport: "gemini-cli",
        model: event.model,
        prompt_version_id: state.prompt_version_id,
        context_manifest_hash: state.context_manifest_hash,
        session_id: event.session_id,
      },
    };
    return {
      state: { ...state, session_id: event.session_id },
      emit: [input],
    };
  }

  // ── message ───────────────────────────────────────────────────────────
  if (event.type === "message") {
    // User messages are ignored — orchestrator already has the prompt
    if (event.role === "user") {
      return { state, emit: [] };
    }

    // Assistant delta — accumulate, emit nothing
    if (event.delta) {
      return {
        state: {
          ...state,
          assistantBuffer: state.assistantBuffer + event.content,
        },
        emit: [],
      };
    }

    // Assistant non-delta — flush buffer + this content as one message
    const text = state.assistantBuffer + event.content;
    const emit: AppendEventInput[] = [];
    if (text.length > 0) {
      emit.push({
        ...base,
        type: "invocation.assistant_message",
        payload: {
          invocation_id: state.invocation_id,
          text,
        },
      } satisfies AppendEventInput<"invocation.assistant_message">);
    }

    return {
      state: { ...state, assistantBuffer: "" },
      emit,
    };
  }

  // ── result ────────────────────────────────────────────────────────────
  // Flush remaining assistant buffer and capture stats into state. The
  // adapter emits the invocation.completed event after the process exits so
  // it can attach stdout/stderr tail hashes.
  if (event.type === "result") {
    const emit: AppendEventInput[] = [];

    if (state.assistantBuffer.length > 0) {
      emit.push({
        ...base,
        type: "invocation.assistant_message",
        payload: {
          invocation_id: state.invocation_id,
          text: state.assistantBuffer,
        },
      } satisfies AppendEventInput<"invocation.assistant_message">);
    }

    return {
      state: {
        ...state,
        assistantBuffer: "",
        seenResult: true,
        result: {
          outcome: event.status === "success" ? "success" : "failed",
          tokens_in: event.stats.input_tokens,
          tokens_out: event.stats.output_tokens,
          duration_ms: event.stats.duration_ms,
        },
      },
      emit,
    };
  }

  // Tool events are decoded so the adapter can observe real stream shape,
  // but are not emitted until args/results can be persisted via blob hashes.
  if (event.type === "tool_use" || event.type === "tool_result") {
    return { state, emit: [] };
  }

  // Unknown event type — passthrough
  return { state, emit: [] };
}
