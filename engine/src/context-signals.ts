/**
 * Derived signals from raw per-agent context samples (hands#103a). The raw
 * series (input + cache-read + cache-creation tokens at each Stop-hook
 * publish) already lands in the DB and renders on a chart — what's missing
 * is turning that into something actionable: a compacting-too-often station
 * is invisible today unless it says so in prose, and "the line is going up"
 * on a chart doesn't tell the expo whether firing a heavy ticket right now
 * is safe.
 *
 * No per-model context-window lookup is used for the "how close to
 * compaction" estimate — the transcript doesn't carry which model an agent
 * is running, and guessing would produce a plausible-looking but potentially
 * wrong denominator. Instead each agent's OWN most recent pre-compaction
 * level is used as a learned ceiling: exact for that agent, available only
 * once it has compacted at least once, and never a guess.
 */

export interface ContextSample {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  at: number;
}

export interface ContextSignals {
  /** compactions detected in the last hour — the "thrashing" signal */
  compactionsLastHour: number;
  /** tokens/minute over the recent window (since the last detected compaction, or all samples if none) */
  slopePerMin: number | null;
  /** linear projection to this agent's own learned ceiling; null without both a ceiling and a positive slope */
  etaToCompactionMin: number | null;
}

/** A sample this much smaller than its predecessor is a compaction, not normal fluctuation. */
const COMPACTION_DROP_RATIO = 0.5;
/** How many of the most recent (post-compaction) samples the slope is fit over. */
const SLOPE_WINDOW = 6;
const HOUR_MS = 60 * 60_000;

function total(s: ContextSample): number {
  return s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens;
}

export function deriveContextSignals(samples: ContextSample[], now: number): ContextSignals {
  const sorted = [...samples].sort((a, b) => a.at - b.at);

  let compactionsLastHour = 0;
  let learnedCeiling: number | null = null;
  let lastCompactionIndex = -1;
  for (let i = 1; i < sorted.length; i++) {
    const prevTotal = total(sorted[i - 1]!);
    const curTotal = total(sorted[i]!);
    if (prevTotal > 0 && curTotal < prevTotal * COMPACTION_DROP_RATIO) {
      if (now - sorted[i]!.at < HOUR_MS) compactionsLastHour++;
      learnedCeiling = learnedCeiling === null ? prevTotal : Math.max(learnedCeiling, prevTotal);
      lastCompactionIndex = i;
    }
  }

  const window = sorted.slice(Math.max(lastCompactionIndex + 1, sorted.length - SLOPE_WINDOW));
  let slopePerMin: number | null = null;
  if (window.length >= 2) {
    const first = window[0]!;
    const last = window[window.length - 1]!;
    const dtMin = (last.at - first.at) / 60_000;
    if (dtMin > 0) slopePerMin = (total(last) - total(first)) / dtMin;
  }

  let etaToCompactionMin: number | null = null;
  if (learnedCeiling !== null && slopePerMin !== null && slopePerMin > 0 && sorted.length > 0) {
    const current = total(sorted[sorted.length - 1]!);
    if (current < learnedCeiling) etaToCompactionMin = (learnedCeiling - current) / slopePerMin;
  }

  return { compactionsLastHour, slopePerMin, etaToCompactionMin };
}
