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
import type { TokenSeries } from "../../src/tokens.js";

/**
 * Output tokens per 15-min bucket, one line per pane (expo + stations), 24h.
 * Hues are assigned in FIXED id order (expo first, then station-N ascending) —
 * never by rank, so a filter or a busy hour never repaints a series. Beyond 5
 * panes, the overflow folds into "other" (still id-ordered, deterministic).
 */
export function TokenBurn({ tokens }: { tokens: TokenSeries | null }) {
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
  const rows = Array.from({ length: bucketCount }, (_, i) => {
    const row: Record<string, number> = { t: tokens.perAgent[ids[0]!]![i]!.t };
    for (const id of shown) row[id] = tokens.perAgent[id]![i]!.out;
    if (folded.length > 0) row.other = folded.reduce((n, id) => n + tokens.perAgent[id]![i]!.out, 0);
    return row;
  });

  const fleetOut = Object.values(tokens.totals24h).reduce((n, t) => n + t.out, 0);

  return (
    <Card id="tokens">
      <CardHeader>
        <CardTitle>Token burn</CardTitle>
        <CardDescription>
          Output tokens per pane · 15-min buckets · last 24h · from Claude Code transcripts
        </CardDescription>
        <CardAction>
          <span className="text-sm font-medium tabular-nums">{fmtTokens(fleetOut)} / 24h</span>
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
        <SubagentCalls tokens={tokens} />
      </CardContent>
    </Card>
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
