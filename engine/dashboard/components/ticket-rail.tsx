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
import { ChitRow } from "@/components/chit-row";
import type { SnapshotTask } from "../../src/snapshot.js";

export function TicketRail({
  tasks,
  taskCosts = {},
  now,
  onSelectChit,
}: {
  tasks: SnapshotTask[];
  /** absent in hosted mode — token/cost telemetry never leaves the machine */
  taskCosts?: Record<number, number>;
  now: number;
  /** absent in hosted mode — hosted has no chit detail page (single-player, local-mode only for now) */
  onSelectChit?: (id: number) => void;
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
                <ChitRow
                  key={t.id}
                  task={t}
                  now={now}
                  cost={taskCosts[t.id]}
                  onClick={onSelectChit ? () => onSelectChit(t.id) : undefined}
                />
              ))}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
