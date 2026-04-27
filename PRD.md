# Compute Cost from Token Counts for All Transports

## Overview

The measurement page has a Cost tab that charts daily spend by provider. Currently, Claude Code reports real `cost_usd` from its subprocess, the Anthropic API adapter computes cost via a pricing table, but the Codex adapter hardcodes `cost_usd: 0` because Codex doesn't report billing cost. Since token counts are already flowing through from all transports, we can compute cost from tokens using a pricing table — making the cost section accurate and useful regardless of which CLI transport is used.

## Extend `modelPricing.ts` with OpenAI model rates

### Add OpenAI models to the existing pricing table

- `server/adapters/modelPricing.ts` already has a `computeCost(model, tokensIn, tokensOut)` function and a lookup table for Anthropic models.
- Add OpenAI model pricing entries alongside the existing Anthropic ones.
- Models to include: `o3`, `o4-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `o3-pro`. Add others as needed.
- Prices should be in USD per 1M tokens (input/output), matching the existing table format.
- Unknown models continue to return 0.

## Update Codex adapter to compute cost from token counts

### Replace hardcoded `cost_usd: 0` in `translateLine`

- In `server/adapters/codex.ts`, the `turn.completed` handler currently sets `cost_usd: 0`.
- Import `computeCost` from `modelPricing.ts`.
- Call `computeCost(opts.model, tokens_in, tokens_out)` to calculate the cost.
- Set the result as `cost_usd` on the `invocation.completed` payload.

### Keep Claude Code adapter unchanged

- `server/adapters/claudeCode.ts` already uses the self-reported `total_cost_usd` from the Claude Code subprocess.
- This is the most accurate source (accounts for prompt caching discounts, etc.).
- Do not change it to use the pricing table.

## Update tests

### Update Codex adapter tests

- `server/adapters/codex.test.ts` has an explicit test (`AC3`) asserting `cost_usd` is always 0.
- Update this test to assert the computed cost based on token counts and the pricing table.
- Add a test that unknown models still produce `cost_usd: 0`.

## Implementation Touchpoints

| File | Change |
|---|---|
| `server/adapters/modelPricing.ts` | Add OpenAI model pricing entries to the existing lookup table |
| `server/adapters/codex.ts` | Import `computeCost`, use it in `turn.completed` handler instead of hardcoded 0 |
| `server/adapters/codex.test.ts` | Update AC3 test to assert computed cost; add unknown-model test |
