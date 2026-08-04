import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
    <Alert variant="destructive">
      <AlertTitle>Needs {principal}</AlertTitle>
      <AlertDescription>
        {questions.map((q) => (
          <div key={q.id}>
            <p>
              <span className="text-xs">
                {q.asker} · {ago(now, q.at)}
              </span>{" "}
              — {q.question}
            </p>
            {q.recommendation ? <p className="pl-4">↳ expo recommends: {q.recommendation}</p> : null}
          </div>
        ))}
      </AlertDescription>
    </Alert>
  );
}

export function OpenQuestions({ questions, now }: { questions: SnapshotQuestion[]; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>At the pass</CardTitle>
        <CardDescription>Open questions awaiting the expo</CardDescription>
        <CardAction>
          <Badge variant="secondary">{questions.length} open</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {questions.length === 0 ? (
          <p className="text-muted-foreground">No open questions.</p>
        ) : (
          questions.map((q) => (
            <div key={q.id} className="flex items-center gap-2 py-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">{q.asker}</span>
              <span className="min-w-0 flex-1">{q.question}</span>
              {q.state === "needs_human" ? <Badge variant="destructive">escalated</Badge> : null}
              <span className="shrink-0 text-xs text-muted-foreground">{ago(now, q.at)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
