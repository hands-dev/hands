import { JournalFeed } from "@/components/journal-feed";
import { NeedsYou, OpenQuestions } from "@/components/questions-lane";
import { Specials } from "@/components/specials";
import { StationsGrid } from "@/components/stations-grid";
import { TicketRail } from "@/components/ticket-rail";
import { Todos } from "@/components/todos";
import { cn } from "@/lib/utils";
import { useSnapshot } from "./use-snapshot.js";

export function App() {
  const { snapshot, connected } = useSnapshot();

  if (!snapshot) {
    return (
      <div className="grid min-h-dvh place-items-center font-mono text-[13px] text-muted-foreground">
        {connected ? "reading the kitchen…" : "connecting…"}
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
    <div className="mx-auto max-w-6xl px-5 pb-10 text-sm">
      <header className="flex items-baseline gap-3 py-5">
        <h1 className="text-[17px] font-semibold tracking-tight">
          Yes, Chef <span className="font-normal text-muted-foreground">· the pass</span>
        </h1>
        <span className="font-mono text-[11px] text-muted-foreground" title={snapshot.db}>
          {snapshot.db.split("/").slice(-2, -1)[0]}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              connected ? "animate-breathe bg-ok" : "bg-warn",
            )}
          />
          {connected ? "live" : "reconnecting…"}
        </span>
      </header>

      <NeedsYou questions={needsHuman} principal={snapshot.principal} now={snapshot.now} />

      <main className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-4">
          <TicketRail tasks={[...activeTasks, ...settledTasks]} now={snapshot.now} />
          <StationsGrid
            agents={snapshot.agents}
            collisions={snapshot.collisions}
            now={snapshot.now}
          />
        </div>
        <div className="space-y-4">
          <Specials items={snapshot.priorities} />
          <OpenQuestions questions={open} now={snapshot.now} />
          <Todos todos={snapshot.todos} principal={snapshot.principal} now={snapshot.now} />
          <JournalFeed journal={snapshot.journal} now={snapshot.now} />
        </div>
      </main>
    </div>
  );
}
