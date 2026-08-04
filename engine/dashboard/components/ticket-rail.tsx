import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { chip, Panel } from "@/components/panel";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { SnapshotTask } from "../../src/snapshot.js";

const STATE_LABEL: Record<string, string> = {
  open: "queued",
  assigned: "fired",
  in_progress: "cooking",
  returned: "at the pass",
  done: "served",
  cancelled: "86'd",
};

function stateBadge(task: SnapshotTask) {
  const label = STATE_LABEL[task.state] ?? task.state;
  if (task.state === "returned")
    return <Badge className={cn(chip, "bg-heat text-heat-foreground")}>{label}</Badge>;
  if (task.state === "in_progress")
    return (
      <Badge variant="secondary" className={cn(chip, "bg-ok/15 text-ok")}>
        {label}
      </Badge>
    );
  if (task.state === "done" || task.state === "cancelled")
    return (
      <Badge variant="outline" className={cn(chip, "text-muted-foreground")}>
        {label}
      </Badge>
    );
  return (
    <Badge variant="secondary" className={chip}>
      {label}
    </Badge>
  );
}

function Chit({ task, now }: { task: SnapshotTask; now: number }) {
  const settled = task.state === "done" || task.state === "cancelled";
  return (
    <div className={cn("flex items-baseline gap-2 py-1.5", settled && "opacity-45")}>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{task.id}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          task.state === "cancelled" && "line-through",
        )}
        title={task.result ? `${task.title}\n\n${task.result}` : task.title}
      >
        {task.title}
      </span>
      {task.assignee ? (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.assignee}</span>
      ) : null}
      {task.priority ? (
        <Badge variant="outline" className={cn(chip, "text-muted-foreground")}>
          {task.priority}
        </Badge>
      ) : null}
      {stateBadge(task)}
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
        {ago(now, task.at)}
      </span>
    </div>
  );
}

export function TicketRail({ tasks, now }: { tasks: SnapshotTask[]; now: number }) {
  const byDish = new Map<string, SnapshotTask[]>();
  for (const t of tasks) {
    const key = t.dish ?? "";
    const list = byDish.get(key) ?? [];
    list.push(t);
    byDish.set(key, list);
  }
  const dishes = [...byDish.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : 0));
  const live = tasks.filter((t) => t.state !== "done" && t.state !== "cancelled").length;

  return (
    <Panel title="The rail" action={`${live} live`}>
      {tasks.length === 0 ? (
        <p className="py-2 text-[13px] text-muted-foreground">Nothing on the rail.</p>
      ) : (
        dishes.map(([dish, list], i) => (
          <div key={dish || "·unattached"}>
            {i > 0 ? <Separator className="my-1" /> : null}
            <div className="pt-1 font-mono text-[11px] tracking-wide text-heat">
              {dish || "unattached"}
            </div>
            {list.map((t) => (
              <Chit key={t.id} task={t} now={now} />
            ))}
          </div>
        ))
      )}
    </Panel>
  );
}
