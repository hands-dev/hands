import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { stateBadge } from "@/components/chit-row";
import { fmtDuration } from "@/lib/format";
import { ago } from "@/lib/time";
import type { SnapshotTask } from "../../src/snapshot.js";

type CraftBrief = { slug: string; mode: string; openedBy: string; at: number; completed: boolean };

function elapsed(task: SnapshotTask, now: number): { label: string; ms: number } {
  if (task.finishedAt != null) {
    return { label: "Elapsed", ms: task.finishedAt - (task.startedAt ?? task.createdAt) };
  }
  if (task.startedAt != null) {
    return { label: "Elapsed so far", ms: now - task.startedAt };
  }
  return { label: "Waiting", ms: now - task.createdAt };
}

function ChitHeader({ task, now }: { task: SnapshotTask; now: number }) {
  const el = elapsed(task, now);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">#{task.id}</span>
          {task.title}
        </CardTitle>
        <CardDescription>
          {task.dish ? `${task.dish} · ` : ""}
          {task.assignee} · filed {ago(now, task.createdAt)}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {task.priority ? <Badge variant="outline">{task.priority}</Badge> : null}
          {stateBadge(task)}
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div>
          <div className="text-muted-foreground">Filed</div>
          <div className="font-medium" title={new Date(task.createdAt).toLocaleString()}>
            {ago(now, task.createdAt)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Started</div>
          <div className="font-medium">
            {task.startedAt != null ? ago(now, task.startedAt) : "not yet"}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Finished</div>
          <div className="font-medium">
            {task.finishedAt != null ? ago(now, task.finishedAt) : "not yet"}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">{el.label}</div>
          <div className="font-medium">{fmtDuration(Math.max(0, el.ms))}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function ChitText({ title, text, empty }: { title: string; text: string | null; empty: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {text ? <p className="whitespace-pre-wrap">{text}</p> : <p className="text-muted-foreground">{empty}</p>}
      </CardContent>
    </Card>
  );
}

function CraftsUsed({ briefs, now }: { briefs: CraftBrief[]; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Crafts used</CardTitle>
        <CardAction>
          <Badge variant="secondary">{briefs.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {briefs.length === 0 ? (
          <p className="text-muted-foreground">No crafts dispatched for this ticket.</p>
        ) : (
          briefs.map((b, i) => (
            <div key={`${b.slug}-${b.at}-${i}`} className="flex items-center gap-2 py-1">
              <span className="font-medium">{b.slug}</span>
              <Badge variant="outline" className="text-[10px]">
                {b.mode}
              </Badge>
              <span className="text-xs text-muted-foreground">{b.openedBy}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {b.completed ? "completed" : "no note yet"} · {ago(now, b.at)}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Honest placeholder — neither a narrative account nor lessons-learned capture exists anywhere
 * on a ticket today (`result` is the only free-text field, and it's already shown as Outcome
 * above). Same framing as role-page.tsx's NotTrackedYet.
 */
function NotTrackedYet() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Narrative &amp; lessons</CardTitle>
        <CardDescription>Not tracked yet</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        There's no capture mechanism for a running account of the work or lessons learned once
        it's done — `result` (Outcome, above) is the only free-text field a ticket has today. This
        needs new instrumentation, not yet built.
      </CardContent>
    </Card>
  );
}

export function ChitPage({
  task,
  craftBriefs,
  now,
}: {
  task: SnapshotTask;
  craftBriefs: CraftBrief[];
  now: number;
}) {
  return (
    <div className="space-y-4">
      <ChitHeader task={task} now={now} />
      <ChitText title="Problem statement" text={task.body} empty="No description given." />
      <ChitText title="Outcome" text={task.result} empty="Not yet returned." />
      <CraftsUsed briefs={craftBriefs} now={now} />
      <NotTrackedYet />
    </div>
  );
}
