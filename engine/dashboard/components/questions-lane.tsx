import { Badge } from "@/components/ui/badge";
import { chip, Panel } from "@/components/panel";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { SnapshotQuestion } from "../../src/snapshot.js";

/** The chef's alarm strip — escalations waiting on the principal. */
export function NeedsYou({
  questions,
  principal,
  now,
}: {
  questions: SnapshotQuestion[];
  principal: string;
  now: number;
}) {
  if (questions.length === 0) return null;
  return (
    <div className="rounded-lg border border-heat bg-heat/10 px-4 py-3">
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-heat">
        Needs {principal}
      </div>
      {questions.map((q) => (
        <div key={q.id} className="mt-1.5 text-[13px]">
          <span className="font-mono text-[11px] text-muted-foreground">
            {q.asker} · {ago(now, q.at)}
          </span>{" "}
          {q.question}
          {q.recommendation ? (
            <div className="pl-4 text-[12.5px] text-muted-foreground">↳ expo: {q.recommendation}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function OpenQuestions({ questions, now }: { questions: SnapshotQuestion[]; now: number }) {
  return (
    <Panel title="At the pass" action={`${questions.length} open`}>
      {questions.length === 0 ? (
        <p className="py-1 text-[13px] text-muted-foreground">No open questions.</p>
      ) : (
        questions.map((q) => (
          <div key={q.id} className="flex items-baseline gap-2 py-1">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{q.asker}</span>
            <span className="min-w-0 flex-1 text-[13px]">{q.question}</span>
            {q.state === "needs_human" ? (
              <Badge className={cn(chip, "bg-heat text-heat-foreground")}>escalated</Badge>
            ) : null}
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
              {ago(now, q.at)}
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}
