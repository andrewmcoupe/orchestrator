/**
 * Model pricing table for supported Anthropic and OpenAI models.
 *
 * Prices are in USD per 1 million tokens (input / output).
 * Sources:
 * - https://www.anthropic.com/pricing
 * - https://platform.openai.com/docs/pricing
 * as of 2026-04-27.
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
 * Includes base model aliases so versioned model names also match via prefix lookup.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI o-series
  "o3": { input_per_1m: 2.0, output_per_1m: 8.0 },
  "o3-pro": { input_per_1m: 20.0, output_per_1m: 80.0 },
  "o4-mini": { input_per_1m: 1.1, output_per_1m: 4.4 },

  // OpenAI GPT-4.1 series
  "gpt-4.1": { input_per_1m: 2.0, output_per_1m: 8.0 },
  "gpt-4.1-mini": { input_per_1m: 0.4, output_per_1m: 1.6 },
  "gpt-4.1-nano": { input_per_1m: 0.1, output_per_1m: 0.4 },

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

const MODEL_PRICING_KEYS_BY_PREFIX_LENGTH = Object.keys(MODEL_PRICING).sort(
  (a, b) => b.length - a.length,
);

/**
 * Computes the USD cost for a given model and token counts.
 * Returns 0 for unknown models — callers should log a warning separately.
 */
export function computeCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  // Try exact match first, then prefer the longest prefix for versioned aliases.
  const matchedKey =
    MODEL_PRICING[model] != null
      ? model
      : MODEL_PRICING_KEYS_BY_PREFIX_LENGTH.find((key) => model.startsWith(key));
  const pricing = matchedKey ? MODEL_PRICING[matchedKey] : undefined;

  if (!pricing) return 0;

  return (
    (tokensIn / 1_000_000) * pricing.input_per_1m +
    (tokensOut / 1_000_000) * pricing.output_per_1m
  );
}
