# Configurable Transport for PRD Ingestion

## Overview

The PRD ingestion step currently hardcodes the Claude Code CLI transport to extract propositions, draft tasks, and pushbacks from a PRD file. Many users prefer subscription-based Codex CLI over expensive API calls. This feature makes the transport configurable so users can choose between Claude Code CLI and Codex CLI for the ingestion phase, with project-level defaults and per-call overrides.

## Add `ingest` block to `config.yaml`

### New configuration shape

- Add an optional `ingest` section to `config.yaml` with `transport` and `model` fields.
- Shape:
  ```yaml
  ingest:
    transport: "codex"        # "claude-code" | "codex"
    model: "gpt-5.5"          # default model for the chosen transport
  ```
- If the `ingest` block is missing, fall back to `claude-code` + `claude-sonnet-4-6` (preserving current behavior).
- Parse and validate the config at startup alongside existing config loading.

## Update `POST /api/commands/prd/ingest` endpoint

### Accept optional `transport` and `model` overrides

- `server/routes/commands.ts` currently accepts `{ path: string } | { content: string }`.
- Extend the request body to accept optional `transport` and `model` fields:
  ```typescript
  {
    path?: string;
    content?: string;
    transport?: "claude-code" | "codex";
    model?: string;
  }
  ```
- If `transport`/`model` are omitted, fall back to `config.yaml` defaults.
- If `config.yaml` has no `ingest` block, fall back to `claude-code` + `claude-sonnet-4-6`.
- Pass the resolved transport and model through to the ingest function.

## Refactor `server/ingest.ts` to support multiple transports

### Add transport dispatcher

- Currently `callExtractionCli` imports `cliInvoke` from `claudeCode.ts` directly and builds CLI-specific options.
- Import the Codex `invoke` from `codex.ts` alongside the existing Claude Code import.
- Add a dispatcher that selects the correct adapter and builds transport-specific options, similar to how `phaseRunner.ts` dispatches at lines 590-657.
- The `ingestPrd` function should accept `transport` and `model` parameters.

### Build transport-specific options

- **Claude Code:** `kind: "cli"`, `permission_mode: "bypassPermissions"`, `disallowed_tools` list (all tools disabled), `schema: EXTRACTION_JSON_SCHEMA`. Unchanged from current behavior.
- **Codex:** `kind: "cli"`, `permission_mode: "plan"` (maps to `--sandbox read-only`), `schema: EXTRACTION_JSON_SCHEMA` (adapter writes to temp file and passes `--output-schema <path>`). No reasoning effort parameter.

### Handle different structured output capture

- **Claude Code:** Structured output arrives as a `StructuredOutput` tool call. Capture via `invocation.tool_called` event and retrieve args from blob store. This is the existing behavior.
- **Codex:** Structured output arrives as the final agent message. Capture via `invocation.assistant_message` event.
- The response capture logic should handle both patterns: check for `StructuredOutput` tool call first (Claude Code), fall back to `assistant_message` (Codex).

### Shared retry loop and validation

- The retry loop (up to `MAX_RETRIES` attempts) and Zod schema validation remain identical regardless of transport.
- No changes to `extractionSchema` or `EXTRACTION_JSON_SCHEMA`.

## Update Ingest UI with transport selector

### Add transport and model dropdowns to the Ingest screen

- `web/src/screens/ingest/Ingest.tsx` currently has a file/content input and triggers ingestion.
- Add a transport dropdown (`Claude Code` / `Codex`) defaulting to the `config.yaml` value.
- Add a model dropdown that updates its options based on the selected transport:
  - Claude Code: `claude-sonnet-4-6` and other Anthropic models.
  - Codex: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.5`.
- Default model from config, allow override per call.
- Send `transport` and `model` fields in the `POST /api/commands/prd/ingest` request.

## Implementation Touchpoints

| File | Change |
|---|---|
| `config.yaml` | Add optional `ingest` block with `transport` and `model` fields |
| `server/routes/commands.ts` | Accept optional `transport` and `model` in ingest request body, resolve defaults from config |
| `server/ingest.ts` | Add transport dispatcher, import Codex adapter, build transport-specific options, handle both structured output patterns |
| `web/src/screens/ingest/Ingest.tsx` | Add transport and model dropdowns, send overrides in API call |

## Out of Scope

- `anthropic-api` transport for ingestion.
- Reasoning effort configuration for Codex.
- GPT-5.x model pricing in `modelPricing.ts` (follow-up PR).
