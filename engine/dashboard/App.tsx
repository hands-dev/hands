import { useEffect, useState } from "react";
import { ChitPage } from "@/components/chit-page";
import { ChitsLog } from "@/components/chits-log";
import { ContextUsage } from "@/components/context-usage";
import { CraftRoster } from "@/components/craft-roster";
import { FeedbackWidget } from "@/components/feedback-form";
import { JournalFeed } from "@/components/journal-feed";
import { NeedsYou, OpenQuestions } from "@/components/questions-lane";
import { RolePage } from "@/components/role-page";
import { Specials } from "@/components/specials";
import { StatCards, StatCardsHosted } from "@/components/stat-cards";
import { StationsGrid, StationsGridHosted } from "@/components/stations-grid";
import { TicketRail } from "@/components/ticket-rail";
import { TokenBurn } from "@/components/token-burn";
import { Todos } from "@/components/todos";
import { Badge } from "@/components/ui/badge";
import { orderedSeriesIds } from "@/lib/series";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useSnapshot } from "./use-snapshot.js";

const NAV_HOSTED = [
  { href: "#overview", label: "Overview" },
  { href: "#line", label: "The line" },
  { href: "#rail", label: "The rail" },
  { href: "#pass", label: "At the pass" },
];

/**
 * Flat top-level tabs. The Roles group (one tab per live agent, id `role:<agentId>`) is generated
 * from the roster at render time, not listed here — station count changes with `hands scale`.
 * "Other kitchens"/"Other crafts" (multiplayer) are deliberately absent — single-player scope for
 * now; the components stay in the repo, unwired, ready for when that's the active priority.
 */
const TOP_TABS = [
  { id: "overview", label: "Overview" },
  { id: "chits", label: "Chits" },
  { id: "crafts", label: "Crafts" },
  { id: "tokens", label: "Token usage" },
  { id: "book", label: "The book" },
] as const;

function initialTabFromHash(): string {
  if (typeof window === "undefined") return "overview";
  return window.location.hash.slice(1) || "overview";
}

function LiveBadge({ connected }: { connected: boolean }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <span
        className={cn("size-2 rounded-full", connected ? "bg-heard" : "bg-amber-500")}
      />
      {connected ? "Live" : "Reconnecting…"}
    </Badge>
  );
}

/** Shared by the sidebar and the mobile pill strip — one `activeTab` source of truth, two layouts. */
function NavButton({
  label,
  active,
  onClick,
  pill,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  pill?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        pill ? "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5" : "rounded-md px-2 py-1.5",
        active && "bg-accent font-medium text-accent-foreground",
      )}
    >
      {label}
    </button>
  );
}

declare global {
  interface Window {
    /**
     * Hosted deployments (hands-website) set this before the module script
     * tag, mirroring shellHtml()'s local shell — lets the SAME compiled
     * bundle poll a hosted JSON route instead of the local SSE stream, with
     * no per-deployment rebuild.
     */
    __HANDS_POLL_URL__?: string;
  }
}

export function App() {
  const pollUrl = typeof window !== "undefined" ? window.__HANDS_POLL_URL__ : undefined;
  const { snapshot, connected, isFetching, lastError } = useSnapshot({ pollUrl });

  // Hook state must stay unconditional (before any early return) — Rules of Hooks. Validating
  // an unrecognized/stale role hash (e.g. a station that's since been removed) happens at render
  // time below, not here; an invalid activeTab just falls through to nothing matching.
  const [activeTab, setActiveTab] = useState<string>(initialTabFromHash);
  useEffect(() => {
    const onHashChange = (): void => setActiveTab(window.location.hash.slice(1) || "overview");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const selectTab = (tab: string): void => {
    setActiveTab(tab);
    window.history.pushState(null, "", `#${tab}`);
  };

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

  if (snapshot.mode === "hosted") {
    // "principal" has no hosted equivalent (see PublicSnapshot's doc
    // comment) — the pushed GitHub handle is the closest available identity
    // string for the same display slots.
    const principal = snapshot.handle;
    const now = Date.now();
    return (
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col gap-6 border-r bg-card px-4 py-5 lg:flex">
          <div>
            <div className="text-base font-semibold tracking-tight">Hands</div>
            <div className="truncate text-xs text-muted-foreground" title={snapshot.project}>
              {snapshot.handle}
            </div>
          </div>
          <nav className="flex flex-col gap-1 text-sm">
            {NAV_HOSTED.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="mt-auto space-y-1.5">
            <LiveBadge connected={connected} />
            <div className="text-xs text-muted-foreground">
              {isFetching ? "syncing…" : `last pushed ${ago(now, snapshot.pushedAt)}`}
            </div>
            {lastError ? (
              <div className="text-xs text-destructive" title={lastError}>
                poll failed — showing last good snapshot
              </div>
            ) : null}
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-6 py-3 backdrop-blur">
            <span className="text-sm font-semibold lg:hidden">Hands</span>
            <span className="text-sm text-muted-foreground">
              The pass · {snapshot.handle} · last pushed {ago(now, snapshot.pushedAt)}
            </span>
            <span className="ml-auto lg:hidden">
              <LiveBadge connected={connected} />
            </span>
          </header>

          <main id="overview" className="space-y-4 px-6 py-5">
            <div id="line">
              <StationsGridHosted crafts={snapshot.crafts} />
            </div>
            <NeedsYou questions={needsHuman} principal={principal} now={now} />
            <StatCardsHosted counts={snapshot.counts} />

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="min-w-0 space-y-4">
                <div id="rail">
                  <TicketRail tasks={[...activeTasks, ...settledTasks]} now={now} />
                </div>
              </div>
              <div className="min-w-0 space-y-4">
                <Specials items={snapshot.priorities} />
                <div id="pass">
                  <OpenQuestions questions={open} now={now} />
                </div>
                <Todos todos={snapshot.todos} principal={principal} now={now} />
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  const kitchen = snapshot.db.split("/").slice(-2, -1)[0] ?? "kitchen";
  const orderedAgentIds = orderedSeriesIds(snapshot.agents.map((a) => a.id));
  const agentsById = new Map(snapshot.agents.map((a) => [a.id, a]));
  const roleTabs = orderedAgentIds.map((id) => ({ id: `role:${id}`, label: id }));

  const activeRoleAgent = activeTab.startsWith("role:")
    ? (agentsById.get(activeTab.slice("role:".length)) ?? null)
    : null;
  const activeChit = activeTab.startsWith("chit:")
    ? (snapshot.tasks.find((t) => t.id === Number(activeTab.slice("chit:".length))) ?? null)
    : null;

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
        <nav className="flex flex-col gap-1 overflow-y-auto text-sm">
          {TOP_TABS.map((tab) => (
            <NavButton key={tab.id} label={tab.label} active={activeTab === tab.id} onClick={() => selectTab(tab.id)} />
          ))}
          {roleTabs.length > 0 ? (
            <>
              <div className="mt-3 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                Roles
              </div>
              {roleTabs.map((tab) => (
                <NavButton
                  key={tab.id}
                  label={tab.label}
                  active={activeTab === tab.id}
                  onClick={() => selectTab(tab.id)}
                />
              ))}
            </>
          ) : null}
        </nav>
        <div className="mt-auto flex flex-col gap-3">
          <FeedbackWidget />
          <LiveBadge connected={connected} />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Topbar */}
        <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
          <div className="flex items-center gap-3 px-6 py-3">
            <span className="text-sm font-semibold lg:hidden">Hands</span>
            <span className="text-sm text-muted-foreground">
              The pass · chef: {snapshot.principal}
            </span>
            <span className="ml-auto lg:hidden">
              <LiveBadge connected={connected} />
            </span>
          </div>
          {/* Mobile tab strip — the sidebar is desktop-only (hidden below lg), so without this,
              switching to tabs would silently strand mobile viewers on whatever tab loads first
              with no way off it. Same activeTab state and click handlers, not a second source of
              truth. */}
          <nav className="flex gap-1 overflow-x-auto border-t px-3 py-2 lg:hidden">
            {[...TOP_TABS, ...roleTabs].map((tab) => (
              <NavButton
                key={tab.id}
                label={tab.label}
                active={activeTab === tab.id}
                onClick={() => selectTab(tab.id)}
                pill
              />
            ))}
          </nav>
        </header>

        <main className="space-y-4 px-6 py-5">
          {activeTab === "overview" ? (
            <>
              <StationsGrid
                agents={snapshot.agents}
                collisions={snapshot.collisions}
                tokens={snapshot.tokens}
                now={snapshot.now}
              />
              <NeedsYou questions={needsHuman} principal={snapshot.principal} now={snapshot.now} />
              <StatCards snapshot={snapshot} />
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <div className="min-w-0 space-y-4">
                  <TicketRail
                    tasks={[...activeTasks, ...settledTasks]}
                    taskCosts={snapshot.taskCosts}
                    now={snapshot.now}
                    onSelectChit={(id) => selectTab(`chit:${id}`)}
                  />
                </div>
                <div className="min-w-0 space-y-4">
                  <Specials items={snapshot.priorities} />
                  <OpenQuestions questions={open} now={snapshot.now} />
                  <Todos todos={snapshot.todos} principal={snapshot.principal} now={snapshot.now} />
                </div>
              </div>
            </>
          ) : null}

          {activeTab === "chits" ? (
            <ChitsLog
              tasks={snapshot.tasks}
              taskCosts={snapshot.taskCosts}
              now={snapshot.now}
              onSelectChit={(id) => selectTab(`chit:${id}`)}
            />
          ) : null}

          {activeTab === "crafts" ? <CraftRoster crafts={snapshot.craftRoster} now={snapshot.now} /> : null}

          {activeTab === "tokens" ? (
            <div className="space-y-4">
              <TokenBurn tokens={snapshot.tokens} agents={snapshot.agents} />
              <ContextUsage contextUsage={snapshot.contextUsage} />
            </div>
          ) : null}

          {activeTab === "book" ? <JournalFeed journal={snapshot.journal} now={snapshot.now} /> : null}

          {activeTab.startsWith("role:") ? (
            activeRoleAgent ? (
              <RolePage
                agent={activeRoleAgent}
                messages={snapshot.agentMessages[activeRoleAgent.id] ?? []}
                now={snapshot.now}
                onSelectRole={(id) => selectTab(`role:${id}`)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {activeTab.slice("role:".length)} isn't currently provisioned.
              </p>
            )
          ) : null}

          {activeTab.startsWith("chit:") ? (
            activeChit ? (
              <ChitPage
                task={activeChit}
                craftBriefs={snapshot.craftBriefsByTicket[activeChit.id] ?? []}
                now={snapshot.now}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Chit #{activeTab.slice("chit:".length)} isn't in the current window — open the
                Chits tab to browse what's visible.
              </p>
            )
          ) : null}
        </main>
      </div>
    </div>
  );
}
