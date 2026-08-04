import { JournalFeed } from "@/components/journal-feed";
import { OtherKitchens } from "@/components/kitchens";
import { NeedsYou, OpenQuestions } from "@/components/questions-lane";
import { Specials } from "@/components/specials";
import { StatCards } from "@/components/stat-cards";
import { StationsGrid } from "@/components/stations-grid";
import { TicketRail } from "@/components/ticket-rail";
import { TokenBurn } from "@/components/token-burn";
import { Todos } from "@/components/todos";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useSnapshot } from "./use-snapshot.js";

const NAV = [
  { href: "#overview", label: "Overview" },
  { href: "#tokens", label: "Token burn" },
  { href: "#rail", label: "The rail" },
  { href: "#line", label: "The line" },
  { href: "#pass", label: "At the pass" },
  { href: "#book", label: "The book" },
  { href: "#kitchens", label: "Other kitchens" },
];

function LiveBadge({ connected }: { connected: boolean }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <span
        className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500")}
      />
      {connected ? "Live" : "Reconnecting…"}
    </Badge>
  );
}

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
  const kitchen = snapshot.db.split("/").slice(-2, -1)[0] ?? "kitchen";

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar — the admin shell's fixed rail (plain layout markup, lg+) */}
      <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col gap-6 border-r bg-card px-4 py-5 lg:flex">
        <div>
          <div className="text-base font-semibold tracking-tight">Hands</div>
          <div className="truncate text-xs text-muted-foreground" title={snapshot.db}>
            {kitchen}
          </div>
        </div>
        <nav className="flex flex-col gap-1 text-sm">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto">
          <LiveBadge connected={connected} />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Topbar */}
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-6 py-3 backdrop-blur">
          <span className="text-sm font-semibold lg:hidden">Hands</span>
          <span className="text-sm text-muted-foreground">
            The pass · chef: {snapshot.principal}
          </span>
          <span className="ml-auto lg:hidden">
            <LiveBadge connected={connected} />
          </span>
        </header>

        <main id="overview" className="space-y-4 px-6 py-5">
          <NeedsYou questions={needsHuman} principal={snapshot.principal} now={snapshot.now} />
          <StatCards snapshot={snapshot} />
          <TokenBurn tokens={snapshot.tokens} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
            <div className="space-y-4">
              <div id="rail">
                <TicketRail tasks={[...activeTasks, ...settledTasks]} now={snapshot.now} />
              </div>
              <div id="line">
                <StationsGrid
                  agents={snapshot.agents}
                  collisions={snapshot.collisions}
                  now={snapshot.now}
                />
              </div>
            </div>
            <div className="space-y-4">
              <Specials items={snapshot.priorities} />
              <div id="pass">
                <OpenQuestions questions={open} now={snapshot.now} />
              </div>
              <Todos todos={snapshot.todos} principal={snapshot.principal} now={snapshot.now} />
              <div id="book">
                <JournalFeed journal={snapshot.journal} now={snapshot.now} />
              </div>
              <div id="kitchens">
                <OtherKitchens kitchens={snapshot.kitchens} now={snapshot.now} />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
