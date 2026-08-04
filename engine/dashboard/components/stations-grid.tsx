import { chip, Panel } from "@/components/panel";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Collision, SnapshotAgent } from "../../src/snapshot.js";

function StateDot({ state }: { state: SnapshotAgent["state"] }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        state === "active" && "animate-breathe bg-ok",
        state === "idle" && "bg-warn",
        state === "offline" && "bg-muted-foreground/40",
      )}
    />
  );
}

function StationCell({ agent, now }: { agent: SnapshotAgent; now: number }) {
  return (
    <div
      className={cn(
        "rounded-md border border-border/70 px-3 py-2",
        agent.state === "offline" && "opacity-45",
      )}
    >
      <div className="flex items-center gap-2">
        <StateDot state={agent.state} />
        <span className="font-mono text-[12.5px] font-semibold">{agent.id}</span>
        {agent.focus ? (
          <span className="truncate text-[12px] text-muted-foreground">· {agent.focus}</span>
        ) : null}
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/70">
          {agent.wakesLastHour}/h · {agent.wakes24h}/24h
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-2 pl-4">
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          {agent.ticket ?? <span className="text-muted-foreground">standing by</span>}
        </span>
        {agent.branch ? (
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
            {agent.branch}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
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
    <Panel
      title="The line"
      action={`${onDuty}/${agents.length} on duty`}
      contentClassName="grid grid-cols-1 gap-2 md:grid-cols-2"
    >
      {agents.length === 0 ? (
        <p className="py-2 text-[13px] text-muted-foreground">
          No stations yet — <span className="font-mono">yes-chef station add -n 2</span>
        </p>
      ) : (
        agents.map((a) => <StationCell key={a.id} agent={a} now={now} />)
      )}
      {collisions.length > 0 ? (
        <div className="rounded-md border border-heat/50 bg-heat/10 px-3 py-2 md:col-span-2">
          <span className={cn(chip, "font-semibold text-heat")}>Crossed wires</span>
          {collisions.map((c) => (
            <div key={`${c.a}·${c.b}·${c.detail}`} className="text-[12.5px]">
              <span className="font-mono">{c.a}</span> ↔ <span className="font-mono">{c.b}</span> —
              same {c.kind}: <span className="font-mono">{c.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
