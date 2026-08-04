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
import type { SnapshotJournal } from "../../src/snapshot.js";

export function JournalFeed({ journal, now }: { journal: SnapshotJournal[]; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>The book</CardTitle>
        <CardDescription>Commits, memories, and notes as they land</CardDescription>
        <CardAction>
          <Badge variant="secondary">{journal.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="max-h-80 overflow-auto text-sm">
        {journal.length === 0 ? (
          <p className="text-muted-foreground">Nothing in the book yet.</p>
        ) : (
          journal.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 py-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">{entry.by}</span>
              <Badge variant="outline">{entry.kind}</Badge>
              <span className="min-w-0 flex-1 truncate" title={entry.text ?? undefined}>
                {entry.text ?? entry.ref}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{ago(now, entry.at)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
