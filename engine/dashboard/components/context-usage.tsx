import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { fmtClock, fmtDuration, fmtTokens } from "@/lib/format";
import { orderedSeriesIds, SERIES_PALETTE } from "@/lib/series";
import { cn } from "@/lib/utils";

export interface ContextSample {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  at: number;
}

/** Mirrors engine/src/context-signals.ts's ContextSignals. */
export interface ContextSignals {
  compactionsLastHour: number;
  slopePerMin: number | null;
  etaToCompactionMin: number | null;
}

/**
 * Context-window size over time, per agent — a proxy for "how full is this session's context
 * right now" (inputTokens + cacheReadTokens + cacheCreationTokens at each Stop-hook publish).
 * Unlike Token burn's fixed 15-min buckets, samples land at irregular per-agent intervals (one
 * per publish, whenever that happens to be) — so this merges every agent's sample timestamps
 * into one shared, sorted row set and leaves a series' value undefined at any row it has no
 * sample for; `connectNulls` draws through those gaps rather than showing a jagged zero-drop.
 */
export function ContextUsage({
  contextUsage,
  contextSignals,
}: {
  contextUsage: Record<string, ContextSample[]>;
  contextSignals: Record<string, ContextSignals>;
}) {
  const withSamples = Object.entries(contextUsage).filter(([, samples]) => samples.length > 0);

  if (withSamples.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Context length</CardTitle>
          <CardDescription>How full each pane's context window is, over time</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No context samples yet — the first one lands after a pane's first turn.
        </CardContent>
      </Card>
    );
  }

  const ids = orderedSeriesIds(withSamples.map(([id]) => id));
  const shown = ids.slice(0, SERIES_PALETTE.length);
  const folded = ids.slice(SERIES_PALETTE.length);

  const config: ChartConfig = {};
  shown.forEach((id, i) => {
    config[id] = { label: id, color: SERIES_PALETTE[i] };
  });
  if (folded.length > 0) config.other = { label: `other (${folded.length})`, color: "var(--muted-foreground)" };

  const byId = new Map(Object.entries(contextUsage));
  const total = (s: ContextSample): number => s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens;

  const times = new Set<number>();
  for (const id of ids) for (const s of byId.get(id) ?? []) times.add(s.at);
  const sortedTimes = [...times].sort((a, b) => a - b);

  const rows = sortedTimes.map((t) => {
    const row: Record<string, number | undefined> = { t };
    for (const id of shown) {
      const sample = (byId.get(id) ?? []).find((s) => s.at === t);
      if (sample) row[id] = total(sample);
    }
    if (folded.length > 0) {
      const foldedSample = folded
        .map((id) => (byId.get(id) ?? []).find((s) => s.at === t))
        .find((s) => s !== undefined);
      if (foldedSample) row.other = total(foldedSample);
    }
    return row;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Context length</CardTitle>
        <CardDescription>
          input + cache-read + cache-creation tokens at each turn · how full a pane's context is
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-[3/1] w-full">
          <LineChart data={rows} margin={{ left: 4, right: 12, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="t"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={48}
              tickFormatter={(t: number) => fmtClock(t)}
            />
            <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => fmtTokens(v)} />
            <ChartTooltip
              cursor
              content={<ChartTooltipContent labelFormatter={(_, p) => fmtClock((p?.[0]?.payload as { t: number }).t)} />}
            />
            <ChartLegend content={<ChartLegendContent />} />
            {Object.keys(config).map((key) => (
              <Line
                key={key}
                dataKey={key}
                type="monotone"
                stroke={`var(--color-${key})`}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
        {/* hands#103a — the derived signals: a compacting-too-often pane, or one about to hit the
            wall, was invisible before this; the raw line above only shows "it went up". */}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {shown.map((id, i) => (
            <ContextSignalBadge key={id} id={id} color={SERIES_PALETTE[i]!} signals={contextSignals[id]} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ContextSignalBadge({
  id,
  color,
  signals,
}: {
  id: string;
  color: string;
  signals: ContextSignals | undefined;
}) {
  if (!signals) return null;
  const { compactionsLastHour, slopePerMin, etaToCompactionMin } = signals;
  const thrashing = compactionsLastHour >= 2;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="font-medium">{id}</span>
      {compactionsLastHour > 0 ? (
        <span
          className={cn(
            "rounded px-1 py-0.5",
            thrashing ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-600 dark:text-amber-500",
          )}
          title={thrashing ? "compacting repeatedly — thrashing" : undefined}
        >
          {compactionsLastHour} compaction{compactionsLastHour === 1 ? "" : "s"}/h
        </span>
      ) : null}
      {slopePerMin !== null && slopePerMin > 0 ? (
        <span className="text-muted-foreground">+{fmtTokens(Math.round(slopePerMin))}/min</span>
      ) : null}
      {etaToCompactionMin !== null ? (
        <span className="text-muted-foreground">
          ~{fmtDuration(etaToCompactionMin * 60_000)} to next compaction
        </span>
      ) : null}
    </div>
  );
}
