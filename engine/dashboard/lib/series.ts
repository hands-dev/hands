/**
 * One place decides series identity → hue, shared by the Token burn chart and
 * the per-station sparklines, so a pane wears the same color everywhere.
 * Fixed id order (expo first, then station-N ascending) — never by rank, so a
 * busy hour never repaints anyone. Beyond the 5 chart hues, panes fold to the
 * muted "other" color (deterministic, still id-ordered).
 */
export const SERIES_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function orderedSeriesIds(ids: string[]): string[] {
  return [...ids].sort((a, b) =>
    a === "expo" ? -1 : b === "expo" ? 1 : a.localeCompare(b, undefined, { numeric: true }),
  );
}

export function seriesColor(orderedIds: string[], id: string): string {
  const index = orderedIds.indexOf(id);
  if (index === -1 || index >= SERIES_PALETTE.length) return "var(--muted-foreground)";
  return SERIES_PALETTE[index]!;
}
