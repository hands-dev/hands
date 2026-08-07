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
import type { Collision, PublicCraft, SnapshotAgent } from "../../src/snapshot.js";
import type { TokenSeries } from "../../src/tokens.js";

/**
 * Readiness (hands#157). Dispatch depends on this, so a station that cannot be
 * given work must LOOK different from one that is merely quiet — those two
 * states are indistinguishable on a board that only shows activity, and that
 * is exactly how a gated kitchen stalls for reasons nobody can name.
 */
function ReadyBadge({ agent }: { agent: SnapshotAgent }) {
  if (agent.ready === "ready") return null;
  const label =
    agent.ready === "declined" ? "declined" : agent.ready === "expired" ? "expired" : "unattested";
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        agent.ready === "declined"
          ? "bg-destructive/15 text-destructive"
          : "bg-amber-500/15 text-amber-600 dark:text-amber-500",
      )}
      // the station's own words, when it has them — only it knows
      title={agent.readyReason ?? "no current attestation — dispatch to this station is blocked"}
    >
      {label}
    </span>
  );
}

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

/** A pending command sitting this long without being drained is "old" (hands#55's motivating case). */
const STALE_COMMAND_MS = 15 * 60_000;

function PendingCommands({ commands, now }: { commands: SnapshotAgent["pendingCommands"]; now: number }) {
  if (commands.length === 0) return null;
  const oldest = commands[0]!;
  const stale = now - oldest.at > STALE_COMMAND_MS;
  const title = commands
    .map((c) => `${c.subject ?? c.body.slice(0, 60)} — ${ago(now, c.at)}`)
    .join("\n");
  return (
    <div className="mt-1.5 pl-4">
      <span
        title={title}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
          stale ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-600",
        )}
      >
        ⏳ {commands.length} pending from expo · oldest {ago(now, oldest.at)}
      </span>
    </div>
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
    <div
      className={cn(
        "rounded-lg border p-3",
        agent.state === "offline" && "opacity-50",
        agent.themeColor && "border-l-[3px]",
      )}
      style={agent.themeColor ? { borderLeftColor: agent.themeColor } : undefined}
    >
      <div className="flex items-center gap-2">
        <StateDot state={agent.state} />
        {agent.themeColor ? (
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: agent.themeColor }}
            title={`theme colour — ${agent.themeColor}`}
          />
        ) : null}
        <span className="font-medium">{agent.sessionName ?? agent.id}</span>
        <ReadyBadge agent={agent} />
        {agent.sessionName ? (
          <span className="truncate font-mono text-xs text-muted-foreground">{agent.id}</span>
        ) : null}
        {agent.focus ? (
          <span className="truncate text-sm text-muted-foreground">{agent.focus}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {agent.wakesLastHour}/h · {agent.wakes24h}/24h
        </span>
      </div>
      {agent.readyReason ? (
        <div className="mt-1 pl-4 text-xs text-destructive" title={agent.readyReason}>
          {agent.readyReason}
        </div>
      ) : null}
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
      <PendingCommands commands={agent.pendingCommands} now={now} />
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
  const blocked = stations.filter((a) => a.ready !== "ready");
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
        {/*
          Kitchen-level readiness (hands#157). With the dispatch gate live,
          "nothing is happening" and "nothing CAN be dispatched" look identical
          from a board that only shows activity. This is the line you read
          without opening a station.
        */}
        {blocked.length > 0 ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <span className="font-medium">
              {blocked.length} of {stations.length} station{stations.length === 1 ? "" : "s"} blocked
            </span>{" "}
            — no tickets can go to {blocked.map((a) => a.sessionName ?? a.id).join(", ")}. Run{" "}
            <span className="font-mono text-xs">/hands:ready</span> there.
          </div>
        ) : null}
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

/**
 * Hosted-mode replacement for StationsGrid: no live presence (pid/cwd/online
 * are meaningless off-machine — see PublicSnapshot's own doc comment), so no
 * state dot, wake counts, ticket/branch line, or token sparkline — just who
 * holds which craft right now, as of the last push.
 */
export function StationsGridHosted({ crafts }: { crafts: PublicCraft[] }) {
  const expo = crafts.find((c) => c.station === "expo");
  const stations = crafts.filter((c) => c.station !== "expo");
  return (
    <Card>
      <CardHeader>
        <CardTitle>The line</CardTitle>
        <CardDescription>Stations and their current craft, as of the last push</CardDescription>
        <CardAction>
          <Badge variant="secondary">{crafts.length} holding a craft</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {crafts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No craft assignments pushed yet.</p>
        ) : (
          <>
            {expo ? (
              <div className="mx-auto max-w-sm">
                <StationCraftCell craft={expo} />
              </div>
            ) : null}
            {stations.length > 0 ? (
              <div className="flex flex-wrap justify-between gap-3">
                {stations.map((c) => (
                  <div key={c.station} className="min-w-56 flex-1">
                    <StationCraftCell craft={c} />
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StationCraftCell({ craft }: { craft: PublicCraft }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{craft.station}</span>
        <span className="truncate text-sm text-muted-foreground">
          {craft.focus ?? <span className="italic">no craft held</span>}
        </span>
      </div>
    </div>
  );
}
