import { Badge } from "@/components/ui/badge";
import { chip, Panel } from "@/components/panel";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { SnapshotJournal } from "../../src/snapshot.js";

export function JournalFeed({ journal, now }: { journal: SnapshotJournal[]; now: number }) {
  return (
    <Panel
      title="The book"
      action={`${journal.length} entries`}
      contentClassName="max-h-80 overflow-auto"
    >
      {journal.length === 0 ? (
        <p className="py-1 text-[13px] text-muted-foreground">Nothing in the book yet.</p>
      ) : (
        journal.map((entry) => (
          <div key={entry.id} className="flex items-baseline gap-2 py-1">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{entry.by}</span>
            <Badge variant="outline" className={cn(chip, "text-muted-foreground")}>
              {entry.kind}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-[12.5px]" title={entry.text ?? undefined}>
              {entry.text ?? entry.ref}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
              {ago(now, entry.at)}
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}
