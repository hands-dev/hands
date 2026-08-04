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
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Collision, SnapshotAgent } from "../../src/snapshot.js";

function StateDot({ state }: { state: SnapshotAgent["state"] }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        state === "active" && "bg-emerald-500",
        state === "idle" && "bg-amber-500",
        state === "offline" && "bg-muted-foreground/30",
      )}
    />
  );
}

function StationCell({ agent, now }: { agent: SnapshotAgent; now: number }) {
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
    </div>
  );
}

export function StationsGrid({
  agents,
  collisions,
  now,
}: {
  agents: SnapshotAgent[];
  collisions: Collision[];
  now: number;
}) {
  const onDuty = agents.filter((a) => a.online).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>The line</CardTitle>
        <CardDescription>Stations, their focus, and wake spend</CardDescription>
        <CardAction>
          <Badge variant="secondary">
            {onDuty}/{agents.length} on duty
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No stations yet — <span className="font-mono text-xs">hands station add -n 2</span>
          </p>
        ) : (
          agents.map((a) => <StationCell key={a.id} agent={a} now={now} />)
        )}
        {collisions.length > 0 ? (
          <Alert variant="destructive" className="md:col-span-2">
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
