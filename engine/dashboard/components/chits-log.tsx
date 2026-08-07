import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChitRow } from "@/components/chit-row";
import type { SnapshotTask } from "../../src/snapshot.js";

/** listTasks()'s own internal clamp — the real ceiling, not a choice made here. */
const CHITS_CAP = 300;

/**
 * Every ticket ever filed, flat and newest-first — an actual log (append order), not the rail's
 * dish-grouped in-flight view. Same ChitRow as the rail, so a ticket looks identical whichever
 * pane you found it in; every row here is a real link into its own detail page.
 */
export function ChitsLog({
  tasks,
  taskCosts = {},
  now,
  onSelectChit,
}: {
  tasks: SnapshotTask[];
  taskCosts?: Record<number, number>;
  now: number;
  onSelectChit: (id: number) => void;
}) {
  const chronological = [...tasks].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chits</CardTitle>
        <CardDescription>Every ticket ever filed</CardDescription>
        <CardAction>
          <Badge variant="secondary">{chronological.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {chronological.length === 0 ? (
          <p className="text-muted-foreground">No tickets filed yet.</p>
        ) : (
          <>
            {chronological.map((t) => (
              <ChitRow key={t.id} task={t} now={now} cost={taskCosts[t.id]} onClick={() => onSelectChit(t.id)} />
            ))}
            {chronological.length >= CHITS_CAP ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the most recent {CHITS_CAP} — more may exist further back.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
