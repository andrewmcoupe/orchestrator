/**
 * Statistical significance calculator for A/B experiments.
 *
 * Uses a two-proportion z-test to compute the p-value for the null hypothesis
 * that the two proportions are equal. Returns a two-tailed p-value.
 *
 * Returns 1 when there is insufficient data to compute significance.
 */

/**
 * Standard normal CDF approximation using the Abramowitz & Stegun method.
 * Accurate to ~7.5e-8.
 */
function normalCdf(z: number): number {
  // Coefficients for the rational approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z);

  const t = 1.0 / (1.0 + p * absZ);
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  const erf = 1 - poly * Math.exp(-absZ * absZ);

  return 0.5 * (1 + sign * erf);
}

/**
 * Two-proportion z-test.
 * Returns the two-tailed p-value for the null hypothesis that pA === pB.
 * Returns 1 when insufficient data (either group has fewer than 1 observation).
 */
export function computeSignificance(
  aSuccesses: number,
  aTotal: number,
  bSuccesses: number,
  bTotal: number,
): number {
  if (aTotal < 1 || bTotal < 1) return 1;

  const pA = aSuccesses / aTotal;
  const pB = bSuccesses / bTotal;
  const pPooled = (aSuccesses + bSuccesses) / (aTotal + bTotal);

  const denom = Math.sqrt(
    pPooled * (1 - pPooled) * (1 / aTotal + 1 / bTotal),
  );

  // If denominator is zero (e.g. all successes or all failures), no test possible
  if (denom === 0) return 1;

  const z = Math.abs((pA - pB) / denom);

  // Two-tailed p-value
  return 2 * (1 - normalCdf(z));
}
