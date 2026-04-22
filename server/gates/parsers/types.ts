/**
 * Shared failure type for all gate output parsers.
 * Matches the shape expected by GateFailed event payload.
 */
export type GateFailure = {
  category: string;
  location?: { path: string; line: number; col?: number };
  excerpt: string;
};
