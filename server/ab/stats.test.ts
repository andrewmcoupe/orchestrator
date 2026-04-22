import { describe, it, expect } from "vitest";
import { computeSignificance } from "./stats.js";

describe("computeSignificance", () => {
  it("returns 1 when both totals are 0 (insufficient data)", () => {
    expect(computeSignificance(0, 0, 0, 0)).toBe(1);
  });

  it("returns 1 when aTotal is 0", () => {
    expect(computeSignificance(0, 0, 5, 10)).toBe(1);
  });

  it("returns 1 when bTotal is 0", () => {
    expect(computeSignificance(5, 10, 0, 0)).toBe(1);
  });

  it("returns 1 when denominator is 0 (identical perfect rates)", () => {
    // Both 100% — no variance, no test possible
    expect(computeSignificance(10, 10, 10, 10)).toBe(1);
  });

  it("perfect separation (10/10 vs 0/10) returns very small p (highly significant)", () => {
    const p = computeSignificance(10, 10, 0, 10);
    expect(p).toBeLessThan(0.001);
  });

  it("50/50 split (5/10 vs 5/10) returns p ≈ 1 (no difference)", () => {
    const p = computeSignificance(5, 10, 5, 10);
    // Same rates → z = 0 → p = 1
    expect(p).toBeCloseTo(1, 4);
  });

  it("known fixture: 90/100 vs 70/100 → p < 0.001", () => {
    const p = computeSignificance(90, 100, 70, 100);
    expect(p).toBeLessThan(0.001);
  });

  it("small difference with large sample returns moderate p", () => {
    // 55% vs 45% with n=200 each should be significant
    const p = computeSignificance(110, 200, 90, 200);
    expect(p).toBeLessThan(0.05);
  });

  it("small difference with small sample returns non-significant p", () => {
    // 6/10 vs 4/10 — not enough data
    const p = computeSignificance(6, 10, 4, 10);
    expect(p).toBeGreaterThan(0.05);
  });

  it("returns value in [0, 1] range", () => {
    const cases: [number, number, number, number][] = [
      [5, 10, 3, 10],
      [90, 100, 70, 100],
      [0, 50, 50, 50],
      [25, 50, 25, 50],
    ];
    for (const [as, at, bs, bt] of cases) {
      const p = computeSignificance(as, at, bs, bt);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("is symmetric: swapping A and B gives the same p-value", () => {
    const p1 = computeSignificance(80, 100, 60, 100);
    const p2 = computeSignificance(60, 100, 80, 100);
    expect(p1).toBeCloseTo(p2, 10);
  });
});
