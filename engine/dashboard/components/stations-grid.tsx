import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkline } from "@/components/sparkline";
import { fmtTokens } from "@/lib/format";
import { orderedSeriesIds, seriesColor } from "@/lib/series";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Collision, SnapshotAgent } from "../../src/snapshot.js";
import type { TokenSeries } from "../../src/tokens.js";

function StateDot({ state }: { state: SnapshotAgent["state"] }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        state === "active" && "bg-heard",
        state === "idle" && "bg-amber-500",
        state === "offline" && "bg-muted-foreground/30",
      )}
    />
  );
}

function StationCell({
  agent,
  now,
  tokens,
  seriesIds,
}: {
  agent: SnapshotAgent;
  now: number;
  tokens: TokenSeries | null;
  seriesIds: string[];
}) {
  const buckets = tokens?.perAgent[agent.id];
  const total = tokens?.totals24h[agent.id]?.out ?? 0;
  return (
    <div className={cn("rounded-lg border p-3", agent.state === "offline" && "opacity-50")}>
      <div className="flex items-center gap-2">
        <StateDot state={agent.state} />
        <span className="font-medium">{agent.id}</span>
        {agent.focus ? (
          <span className="truncate text-sm text-muted-foreground">{agent.focus}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {agent.wakesLastHour}/h · {agent.wakes24h}/24h
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-4 text-sm">
        <span className="min-w-0 flex-1 truncate">
          {agent.ticket ?? <span className="text-muted-foreground">standing by</span>}
        </span>
        {agent.branch ? (
          <span className="truncate font-mono text-xs text-muted-foreground">{agent.branch}</span>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground">
          {ago(now, agent.lastActive ?? agent.lastSeen)}
        </span>
      </div>
      {buckets ? (
        <div className="mt-2">
          <Sparkline
            points={buckets.map((b) => b.out)}
            stroke={seriesColor(seriesIds, agent.id)}
            title={`${agent.id} — ${fmtTokens(total)} output tokens in 24h`}
          />
        </div>
      ) : null}
    </div>
  );
}

export function StationsGrid({
  agents,
  collisions,
  tokens,
  now,
}: {
  agents: SnapshotAgent[];
  collisions: Collision[];
  tokens: TokenSeries | null;
  now: number;
}) {
  const onDuty = agents.filter((a) => a.online).length;
  const seriesIds = orderedSeriesIds(Object.keys(tokens?.perAgent ?? {}));
  // Expo gets its own centered row above the stations — a clearer visual
  // hierarchy than treating it as just another cell in the grid. Stations
  // stay in their existing (registration) order.
  const expo = agents.find((a) => a.id === "expo");
  const stations = agents.filter((a) => a.id !== "expo");
  return (
    <Card>
      <CardHeader>
        <CardTitle>The line</CardTitle>
        <CardDescription>Stations, their focus, wake spend, and token burn</CardDescription>
        <CardAction>
          <Badge variant="secondary">
            {onDuty}/{agents.length} on duty
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No stations yet — <span className="font-mono text-xs">hands station add -n 2</span>
          </p>
        ) : (
          <>
            {expo ? (
              <div className="mx-auto max-w-sm">
                <StationCell agent={expo} now={now} tokens={tokens} seriesIds={seriesIds} />
              </div>
            ) : null}
            {stations.length > 0 ? (
              <div className="flex flex-wrap justify-between gap-3">
                {stations.map((a) => (
                  <div key={a.id} className="min-w-56 flex-1">
                    <StationCell agent={a} now={now} tokens={tokens} seriesIds={seriesIds} />
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
        {collisions.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>Crossed wires</AlertTitle>
            <AlertDescription>
              {collisions.map((c) => (
                <p key={`${c.a}·${c.b}·${c.detail}`}>
                  {c.a} ↔ {c.b} — same {c.kind}:{" "}
                  <span className="font-mono text-xs">{c.detail}</span>
                </p>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
