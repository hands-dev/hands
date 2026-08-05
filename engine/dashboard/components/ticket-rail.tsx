import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { fmtTokens } from "@/lib/format";
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
  if (task.state === "returned") return <Badge>{label}</Badge>;
  if (task.state === "in_progress") return <Badge variant="secondary">{label}</Badge>;
  if (task.state === "done" || task.state === "cancelled")
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    );
  return <Badge variant="outline">{label}</Badge>;
}

function Chit({ task, now, cost }: { task: SnapshotTask; now: number; cost?: number }) {
  const settled = task.state === "done" || task.state === "cancelled";
  return (
    <div className={cn("flex items-start gap-2 py-1.5", settled && "opacity-50")}>
      <span className="w-7 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
        #{task.id}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 break-words",
          task.state === "cancelled" && "line-through",
        )}
        title={task.result ? `${task.title}\n\n${task.result}` : task.title}
      >
        {task.title}
      </span>
      {cost !== undefined && cost > 0 ? (
        <span
          className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums"
          title="≈ output tokens spent by the assignee over this ticket's working interval"
        >
          ~{fmtTokens(cost)}
        </span>
      ) : null}
      {task.assignee ? (
        <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{task.assignee}</span>
      ) : null}
      {task.priority ? (
        <Badge variant="outline" className="shrink-0">
          {task.priority}
        </Badge>
      ) : null}
      <span className="shrink-0">{stateBadge(task)}</span>
      <span className="w-16 shrink-0 pt-0.5 text-right text-xs text-muted-foreground">
        {ago(now, task.at)}
      </span>
    </div>
  );
}

export function TicketRail({
  tasks,
  taskCosts = {},
  now,
}: {
  tasks: SnapshotTask[];
  /** absent in hosted mode — token/cost telemetry never leaves the machine */
  taskCosts?: Record<number, number>;
  now: number;
}) {
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
    <Card>
      <CardHeader>
        <CardTitle>The rail</CardTitle>
        <CardDescription>Tickets in flight, grouped by dish</CardDescription>
        <CardAction>
          <Badge variant="secondary">{live} live</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {tasks.length === 0 ? (
          <p className="text-muted-foreground">Nothing on the rail.</p>
        ) : (
          dishes.map(([dish, list], i) => (
            <div key={dish || "·unattached"}>
              {i > 0 ? <Separator className="my-2" /> : null}
              <div className="text-xs font-medium text-muted-foreground">
                {dish || "Unattached"}
              </div>
              {list.map((t) => (
                <Chit key={t.id} task={t} now={now} cost={taskCosts[t.id]} />
              ))}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
