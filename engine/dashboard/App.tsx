import { JournalFeed } from "@/components/journal-feed";
import { NeedsYou, OpenQuestions } from "@/components/questions-lane";
import { Specials } from "@/components/specials";
import { StationsGrid } from "@/components/stations-grid";
import { TicketRail } from "@/components/ticket-rail";
import { Todos } from "@/components/todos";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useSnapshot } from "./use-snapshot.js";

export function App() {
  const { snapshot, connected } = useSnapshot();

  if (!snapshot) {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-muted-foreground">
        {connected ? "Reading the kitchen…" : "Connecting…"}
      </div>
    );
  }

  const needsHuman = snapshot.questions.filter((q) => q.state === "needs_human");
  const open = snapshot.questions.filter((q) => q.state === "open");
  const activeTasks = snapshot.tasks.filter((t) => t.state !== "done" && t.state !== "cancelled");
  const settledTasks = snapshot.tasks
    .filter((t) => t.state === "done" || t.state === "cancelled")
    .slice(0, 8);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <header className="flex items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Yes, Chef</h1>
          <p className="text-sm text-muted-foreground" title={snapshot.db}>
            The pass · {snapshot.db.split("/").slice(-2, -1)[0]}
          </p>
        </div>
        <Badge variant="outline" className="ml-auto gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              connected ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
          {connected ? "Live" : "Reconnecting…"}
        </Badge>
      </header>

      <NeedsYou questions={needsHuman} principal={snapshot.principal} now={snapshot.now} />

      <main className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <TicketRail tasks={[...activeTasks, ...settledTasks]} now={snapshot.now} />
          <StationsGrid
            agents={snapshot.agents}
            collisions={snapshot.collisions}
            now={snapshot.now}
          />
        </div>
        <div className="space-y-6">
          <Specials items={snapshot.priorities} />
          <OpenQuestions questions={open} now={snapshot.now} />
          <Todos todos={snapshot.todos} principal={snapshot.principal} now={snapshot.now} />
          <JournalFeed journal={snapshot.journal} now={snapshot.now} />
        </div>
      </main>
    </div>
  );
}
