import { useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  Card,
  CardAction,
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
import { fmtClock, fmtTokens } from "@/lib/format";
import { orderedSeriesIds, SERIES_PALETTE } from "@/lib/series";
import { cn } from "@/lib/utils";
import type { SnapshotAgent } from "../../src/snapshot.js";
import type { TokenSeries } from "../../src/tokens.js";

/** Selectable chart windows, in 15-min buckets (the sampler's fixed bucket size). */
const WINDOWS = [
  { label: "1h", buckets: 4 },
  { label: "6h", buckets: 24 },
  { label: "24h", buckets: 96 },
] as const;
type WindowLabel = (typeof WINDOWS)[number]["label"];

/**
 * Output tokens per 15-min bucket, one line per pane (expo + stations),
 * defaulting to the last hour (selectable up to the full 24h sample window).
 * Hues are assigned in FIXED id order (expo first, then station-N ascending) —
 * never by rank, so a filter or a busy hour never repaints a series. Beyond 5
 * panes, the overflow folds into "other" (still id-ordered, deterministic).
 */
export function TokenBurn({ tokens, agents }: { tokens: TokenSeries | null; agents: SnapshotAgent[] }) {
  const [windowLabel, setWindowLabel] = useState<WindowLabel>("1h");

  if (!tokens || Object.keys(tokens.perAgent).length === 0) {
    return (
      <Card id="tokens">
        <CardHeader>
          <CardTitle>Token burn</CardTitle>
          <CardDescription>Output tokens per pane, from Claude Code transcripts</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No transcript data yet — the first sample lands within a minute of a pane working.
        </CardContent>
      </Card>
    );
  }

  const ids = orderedSeriesIds(Object.keys(tokens.perAgent));
  const shown = ids.slice(0, SERIES_PALETTE.length);
  const folded = ids.slice(SERIES_PALETTE.length);

  const config: ChartConfig = {};
  shown.forEach((id, i) => {
    config[id] = { label: id, color: SERIES_PALETTE[i] };
  });
  if (folded.length > 0) config.other = { label: `other (${folded.length})`, color: "var(--muted-foreground)" };

  const bucketCount = tokens.perAgent[ids[0]!]!.length;
  const windowBuckets = Math.min(WINDOWS.find((w) => w.label === windowLabel)!.buckets, bucketCount);
  const start = bucketCount - windowBuckets;
  const allRows = Array.from({ length: bucketCount }, (_, i) => {
    const row: Record<string, number> = { t: tokens.perAgent[ids[0]!]![i]!.t };
    for (const id of shown) row[id] = tokens.perAgent[id]![i]!.out;
    if (folded.length > 0) row.other = folded.reduce((n, id) => n + tokens.perAgent[id]![i]!.out, 0);
    return row;
  });
  const rows = allRows.slice(start);

  const fleetOut = rows.reduce((n, row) => n + Object.keys(config).reduce((m, key) => m + (row[key] ?? 0), 0), 0);

  return (
    <Card id="tokens">
      <CardHeader>
        <CardTitle>Token burn</CardTitle>
        <CardDescription>
          Output tokens per pane · 15-min buckets · last {windowLabel} · from Claude Code transcripts
        </CardDescription>
        <CardAction className="flex items-center gap-3">
          <div className="flex overflow-hidden rounded-md border text-xs">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                onClick={() => setWindowLabel(w.label)}
                className={cn(
                  "px-2 py-1 font-medium",
                  w.label === windowLabel
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
          <span className="text-sm font-medium tabular-nums">{fmtTokens(fleetOut)} / {windowLabel}</span>
        </CardAction>
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
            <YAxis
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => fmtTokens(v)}
            />
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
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
        <WakesVsTokens tokens={tokens} agents={agents} />
        <SubagentCalls tokens={tokens} />
      </CardContent>
    </Card>
  );
}

/**
 * Wakes are the OTHER half of "why did this pane spend tokens" — a wake with
 * no output is a no-op turn, a wake with heavy output is real work. The chart
 * only shows output tokens, so surface wake counts (hands#54) right beside
 * each pane's 24h total instead of leaving them only on the line/StationsGrid.
 */
function WakesVsTokens({ tokens, agents }: { tokens: TokenSeries; agents: SnapshotAgent[] }) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const ids = orderedSeriesIds(Object.keys(tokens.perAgent));
  return (
    <div className="mt-4 border-t pt-3">
      <div className="text-xs font-medium text-muted-foreground">Wakes vs. output (24h)</div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        {ids.map((id) => {
          const agent = byId.get(id);
          const out = tokens.totals24h[id]?.out ?? 0;
          return (
            <div key={id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{id}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {agent?.wakes24h ?? 0} wakes · {fmtTokens(out)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Recent Agent-tool calls per pane — each is real spend inside that pane's line. */
function SubagentCalls({ tokens }: { tokens: TokenSeries }) {
  const rows = Object.entries(tokens.subagents ?? {})
    .flatMap(([pane, calls]) => calls.map((c) => ({ pane, ...c })))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8);
  if (rows.length === 0) return null;
  return (
    <div className="mt-4 border-t pt-3">
      <div className="text-xs font-medium text-muted-foreground">Recent sub-agent calls</div>
      <div className="mt-1.5 text-sm">
        {rows.map((r) => (
          <div key={`${r.pane}·${r.ts}·${r.label}`} className="flex items-center gap-2 py-1">
            <span className="shrink-0 text-xs text-muted-foreground">{r.pane}</span>
            <span className="min-w-0 flex-1 truncate" title={r.label}>
              {r.label}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              ~{fmtTokens(r.out)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
