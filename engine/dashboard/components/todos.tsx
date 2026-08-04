import { Panel } from "@/components/panel";
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
    <Panel title={`${principal}'s list`} action={`${open.length} open`}>
      {todos.length === 0 ? (
        <p className="py-1 text-[13px] text-muted-foreground">Nothing on your list.</p>
      ) : (
        todos.map((t) => (
          <div
            key={t.id}
            className={cn("flex items-baseline gap-2 py-1", t.state !== "open" && "opacity-45")}
          >
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {t.state === "open" ? "☐" : "☑"}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 text-[13px]",
                t.state === "dismissed" && "line-through",
              )}
              title={t.detail ?? undefined}
            >
              {t.title}
            </span>
            {t.origin ? (
              <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                {t.origin}
              </span>
            ) : null}
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
              {ago(now, t.at)}
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}
