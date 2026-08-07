import { useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtDuration, fmtTokens } from "@/lib/format";
import { renderBlock, renderInline } from "@/lib/markdown";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { DashboardCraft } from "../../src/serve.js";

function CraftListRow({
  craft,
  selected,
  onSelect,
}: {
  craft: DashboardCraft;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{craft.slug}</span>
        <Badge variant="outline" className="text-[10px]">
          {craft.scope}
        </Badge>
        {craft.pendingNotes > 0 ? (
          <Badge variant="secondary" className="text-[10px]">
            {craft.pendingNotes} pending
          </Badge>
        ) : null}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {craft.usage.dispatchCount === 1 ? "1 dispatch" : `${craft.usage.dispatchCount} dispatches`}
        </span>
      </div>
      <p className="min-w-0 truncate text-xs text-muted-foreground">{craft.covers ?? "no covers stated yet"}</p>
    </button>
  );
}

function NoteHistoryRow({ note, now }: { note: DashboardCraft["history"][number]; now: number }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Badge variant="outline" className="shrink-0 text-[10px]">
        {note.kind}
      </Badge>
      <span
        className="min-w-0 flex-1 break-words text-xs [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_p]:inline"
        dangerouslySetInnerHTML={{ __html: renderInline(note.body) }}
      />
      <span className="shrink-0 text-xs text-muted-foreground">{note.source_agent}</span>
      <Badge variant={note.folded_at ? "secondary" : "outline"} className="shrink-0 text-[10px]">
        {note.folded_at ? "folded" : "pending"}
      </Badge>
      <span className="shrink-0 text-xs text-muted-foreground">{ago(now, note.created_at)}</span>
    </div>
  );
}

function CraftDoc({ text, label }: { text: string | null; label: string }) {
  if (!text) return <p className="text-sm text-muted-foreground">No {label} yet.</p>;
  return (
    <div
      className="max-h-64 overflow-auto break-words text-sm [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2"
      dangerouslySetInnerHTML={{ __html: renderBlock(text) }}
    />
  );
}

function CraftDetail({ craft, now }: { craft: DashboardCraft; now: number }) {
  const { usage, tokens } = craft;
  return (
    <div className="space-y-3">
      <Tabs defaultValue="book">
        <TabsList>
          <TabsTrigger value="book">Book</TabsTrigger>
          <TabsTrigger value="mise">Mise</TabsTrigger>
          <TabsTrigger value="skill">Skill</TabsTrigger>
        </TabsList>
        <TabsContent value="book">
          <CraftDoc text={craft.book} label="book" />
        </TabsContent>
        <TabsContent value="mise">
          <CraftDoc text={craft.mise} label="mise" />
        </TabsContent>
        <TabsContent value="skill">
          <CraftDoc text={craft.skill} label="skill" />
        </TabsContent>
      </Tabs>

      <Separator />

      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Note history</div>
        <div className="max-h-80 overflow-auto">
          {craft.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No notes yet.</p>
          ) : (
            craft.history.map((n) => <NoteHistoryRow key={n.id} note={n} now={now} />)
          )}
        </div>
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
        <div>
          <div className="text-muted-foreground">Dispatches</div>
          <div className="font-medium">{usage.dispatchCount}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Last used</div>
          <div className="font-medium">{usage.lastDispatchedAt ? ago(now, usage.lastDispatchedAt) : "never"}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Stations</div>
          <div className="truncate font-medium" title={usage.stations.join(", ")}>
            {usage.stations.length ? usage.stations.join(", ") : "—"}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Avg. duration</div>
          <div className="font-medium">{usage.avgDurationMs != null ? fmtDuration(usage.avgDurationMs) : "—"}</div>
          <div className="text-[10px] text-muted-foreground">
            {usage.completedCount} of {usage.dispatchCount} reported
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Token usage</div>
          <div className="font-medium">{tokens ? fmtTokens(tokens.totalOutputTokens) : "—"}</div>
          <div className="text-[10px] text-muted-foreground">last 7d, synced dispatches only</div>
        </div>
      </div>
    </div>
  );
}

/**
 * THIS repo's own craft roster — distinct from the "Other kitchens' crafts" panel
 * (components/crafts.tsx), which shows other handles' crafts pulled from the shared books. First
 * click-to-select panel on this dashboard (every other panel is hover-tooltip-as-detail) — a
 * whole book/skill document and a scrollable note history don't fit a `title=` tooltip.
 */
export function CraftRoster({ crafts, now }: { crafts: DashboardCraft[]; now: number }) {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const selected = crafts.find((c) => c.slug === selectedSlug) ?? crafts[0] ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crafts</CardTitle>
        <CardDescription>This kitchen's own crafts — book, mise, skill, and what they've learned</CardDescription>
        <CardAction>
          <Badge variant="secondary">{crafts.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {crafts.length === 0 ? (
          <p className="text-muted-foreground">
            No crafts founded yet — /hands:crafts surveys the repo and proposes a roster.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div className="space-y-1">
              {crafts.map((c) => (
                <CraftListRow
                  key={c.slug}
                  craft={c}
                  selected={c.slug === selected?.slug}
                  onSelect={() => setSelectedSlug(c.slug)}
                />
              ))}
            </div>
            <div className="min-w-0 border-t pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4">
              {selected ? <CraftDetail craft={selected} now={now} /> : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
