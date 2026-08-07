import { Badge } from "@/components/ui/badge";
import { fmtTokens } from "@/lib/format";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { SnapshotTask } from "../../src/snapshot.js";

export const STATE_LABEL: Record<string, string> = {
  open: "queued",
  assigned: "fired",
  in_progress: "cooking",
  returned: "at the pass",
  done: "served",
  cancelled: "86'd",
};

export function stateBadge(task: SnapshotTask) {
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

/**
 * One ticket, one row — shared by the rail (grouped by dish) and the Chits log (flat,
 * chronological) so both surfaces render the exact same ticket identically, not lookalikes.
 * Clickable when `onClick` is given (both callers wire it to the same chit detail page).
 */
export function ChitRow({
  task,
  now,
  cost,
  onClick,
}: {
  task: SnapshotTask;
  now: number;
  cost?: number;
  onClick?: () => void;
}) {
  const settled = task.state === "done" || task.state === "cancelled";
  const Row = onClick ? "button" : "div";
  return (
    <Row
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 py-1.5 text-left",
        settled && "opacity-50",
        onClick && "rounded-md hover:bg-accent",
      )}
    >
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
    </Row>
  );
}
