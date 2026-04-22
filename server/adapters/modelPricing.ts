/**
 * Model pricing table for Anthropic models.
 *
 * Prices are in USD per 1 million tokens (input / output).
 * Source: https://www.anthropic.com/pricing (as of 2026-04)
 *
 * When a model ID is unknown, computeCost() returns 0 so cost calculations
 * degrade gracefully rather than throwing.
 */

export type ModelPricing = {
  input_per_1m: number;
  output_per_1m: number;
};

/**
 * Pricing entries keyed by model ID.
 * Includes prefix aliases so short model names also match.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4.6 / 4.7
  "claude-opus-4-6": { input_per_1m: 15.0, output_per_1m: 75.0 },
  "claude-opus-4-7": { input_per_1m: 15.0, output_per_1m: 75.0 },

  // Claude Sonnet 4.6 / 4.5
  "claude-sonnet-4-6": { input_per_1m: 3.0, output_per_1m: 15.0 },
  "claude-sonnet-4-5": { input_per_1m: 3.0, output_per_1m: 15.0 },

  // Claude Haiku 4.5
  "claude-haiku-4-5": { input_per_1m: 0.8, output_per_1m: 4.0 },

  // Legacy / alternate IDs that may appear in API responses
  "claude-3-5-sonnet-20241022": { input_per_1m: 3.0, output_per_1m: 15.0 },
  "claude-3-5-haiku-20241022": { input_per_1m: 0.8, output_per_1m: 4.0 },
  "claude-3-opus-20240229": { input_per_1m: 15.0, output_per_1m: 75.0 },
};

/**
 * Computes the USD cost for a given model and token counts.
 * Returns 0 for unknown models — callers should log a warning separately.
 */
export function computeCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  // Try exact match first, then prefix match for versioned aliases
  const pricing =
    MODEL_PRICING[model] ??
    Object.entries(MODEL_PRICING).find(([key]) => model.startsWith(key))?.[1];

  if (!pricing) return 0;

  return (
    (tokensIn / 1_000_000) * pricing.input_per_1m +
    (tokensOut / 1_000_000) * pricing.output_per_1m
  );
}
