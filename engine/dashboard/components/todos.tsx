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
import type { SnapshotTodo } from "../../src/snapshot.js";

export function Todos({
  todos,
  principal,
  now,
}: {
  todos: SnapshotTodo[];
  principal: string;
  now: number;
}) {
  const open = todos.filter((t) => t.state === "open");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{principal}'s list</CardTitle>
        <CardDescription>Only things the chef can do</CardDescription>
        <CardAction>
          <Badge variant="secondary">{open.length} open</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {todos.length === 0 ? (
          <p className="text-muted-foreground">Nothing on your list.</p>
        ) : (
          todos.map((t) => (
            <div
              key={t.id}
              className={cn("flex items-center gap-2 py-1.5", t.state !== "open" && "opacity-50")}
            >
              <input
                type="checkbox"
                checked={t.state !== "open"}
                readOnly
                className="size-3.5 accent-primary"
              />
              <span
                className={cn("min-w-0 flex-1", t.state === "dismissed" && "line-through")}
                title={t.detail ?? undefined}
              >
                {t.title}
              </span>
              {t.origin ? (
                <span className="shrink-0 text-xs text-muted-foreground">{t.origin}</span>
              ) : null}
              <span className="shrink-0 text-xs text-muted-foreground">{ago(now, t.at)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
