import { describe, expect, it } from "vitest";
import { deriveContextSignals, type ContextSample } from "../src/context-signals.js";

const NOW = Date.parse("2026-08-07T12:00:00Z");
const MIN = 60_000;

function sample(at: number, total: number): ContextSample {
  // split arbitrarily across the three fields — deriveContextSignals only cares about the sum
  return { inputTokens: Math.floor(total / 2), cacheReadTokens: Math.ceil(total / 2), cacheCreationTokens: 0, at };
}

describe("deriveContextSignals", () => {
  it("returns nulls/zero for no samples", () => {
    expect(deriveContextSignals([], NOW)).toEqual({
      compactionsLastHour: 0,
      slopePerMin: null,
      etaToCompactionMin: null,
    });
  });

  it("returns no slope from a single sample — nothing to fit a line through", () => {
    const signals = deriveContextSignals([sample(NOW, 10_000)], NOW);
    expect(signals.slopePerMin).toBeNull();
    expect(signals.compactionsLastHour).toBe(0);
  });

  it("computes a positive slope from steadily growing samples, with no ETA (no learned ceiling yet)", () => {
    const samples = [
      sample(NOW - 20 * MIN, 10_000),
      sample(NOW - 10 * MIN, 20_000),
      sample(NOW, 30_000),
    ];
    const signals = deriveContextSignals(samples, NOW);
    expect(signals.slopePerMin).toBeCloseTo(1000, 0); // 20k tokens over 20 minutes
    expect(signals.etaToCompactionMin).toBeNull();
    expect(signals.compactionsLastHour).toBe(0);
  });

  it("detects a sharp drop as a compaction, and learns the pre-compaction level as a ceiling", () => {
    const samples = [
      sample(NOW - 30 * MIN, 50_000),
      sample(NOW - 20 * MIN, 90_000), // peak, right before compaction
      sample(NOW - 10 * MIN, 5_000), // compacted — well under half of 90k
    ];
    const signals = deriveContextSignals(samples, NOW);
    expect(signals.compactionsLastHour).toBe(1);
  });

  it("does NOT flag a normal dip (less than half) as a compaction", () => {
    const samples = [sample(NOW - 10 * MIN, 50_000), sample(NOW, 30_000)]; // dropped, but > half of 50k
    const signals = deriveContextSignals(samples, NOW);
    expect(signals.compactionsLastHour).toBe(0);
  });

  it("only counts compactions within the last hour, but the learned ceiling still applies to older ones", () => {
    const samples = [
      sample(NOW - 3 * 60 * MIN, 80_000), // peak, 3h ago
      sample(NOW - 2 * 60 * MIN + 55 * MIN, 5_000), // compacted just over 2h ago — outside the 1h window
      sample(NOW - 20 * MIN, 10_000),
      sample(NOW, 20_000),
    ];
    const signals = deriveContextSignals(samples, NOW);
    expect(signals.compactionsLastHour).toBe(0); // the compaction itself is stale
    // but the 80k peak is still the learned ceiling, so an ETA can still be projected
    expect(signals.etaToCompactionMin).not.toBeNull();
  });

  it("projects an ETA to compaction from the post-compaction slope and the learned ceiling", () => {
    const samples = [
      sample(NOW - 40 * MIN, 90_000), // peak before compaction
      sample(NOW - 30 * MIN, 10_000), // compacted
      sample(NOW - 20 * MIN, 30_000), // growing again, 2000/min
      sample(NOW - 10 * MIN, 50_000),
      sample(NOW, 70_000),
    ];
    const signals = deriveContextSignals(samples, NOW);
    expect(signals.compactionsLastHour).toBe(1);
    expect(signals.slopePerMin).toBeCloseTo(2000, 0);
    // current 70k, ceiling 90k, growing 2000/min -> 10 minutes out
    expect(signals.etaToCompactionMin).toBeCloseTo(10, 0);
  });

  it("reports no ETA once the current level has already caught up to (or passed) the learned ceiling", () => {
    const samples = [
      sample(NOW - 20 * MIN, 90_000),
      sample(NOW - 10 * MIN, 10_000), // compacted
      sample(NOW, 95_000), // already past the old ceiling
    ];
    const signals = deriveContextSignals(samples, NOW);
    expect(signals.etaToCompactionMin).toBeNull();
  });

  it("is order-independent — unsorted input samples produce the same result as sorted", () => {
    const sorted = [sample(NOW - 20 * MIN, 10_000), sample(NOW - 10 * MIN, 20_000), sample(NOW, 30_000)];
    const shuffled = [sorted[2]!, sorted[0]!, sorted[1]!];
    expect(deriveContextSignals(shuffled, NOW)).toEqual(deriveContextSignals(sorted, NOW));
  });
});
