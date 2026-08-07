import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ago } from "@/lib/time";
import type { SnapshotQuestion } from "../../src/snapshot.js";

type AnswerResult =
  | { ok: true; answer: string; resolvedBy: string; answeredVia: string }
  | { ok: false; reason: "already-answered"; answer: string | null; resolvedBy: string | null; answeredVia: string | null }
  | { ok: false; reason: "http"; message: string };

async function postAnswer(id: number, body: { chosenLabels?: string[]; freeText?: string }): Promise<AnswerResult> {
  try {
    const res = await fetch(`/api/questions/${id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Partial<AnswerResult> & { error?: string } | null;
    if (!res.ok || !data) return { ok: false, reason: "http", message: data?.error ?? `HTTP ${res.status}` };
    if (data.ok) return data as AnswerResult;
    return {
      ok: false,
      reason: "already-answered",
      answer: (data as { answer?: string | null }).answer ?? null,
      resolvedBy: (data as { resolvedBy?: string | null }).resolvedBy ?? null,
      answeredVia: (data as { answeredVia?: string | null }).answeredVia ?? null,
    };
  } catch (err) {
    return { ok: false, reason: "http", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Renders a structured question's options as buttons — the dashboard's half of hands#84's
 * write path. Single-select answers on click (one click = a decision, the whole point of the
 * feature); multi-select toggles a selection then needs an explicit Submit. A free-text
 * fallback below the buttons keeps parity with the TUI's AskUserQuestion, which always offers
 * one. Owns its own local state (not the parent's) so several questions in the same list don't
 * share a submitting/result flag.
 */
function AnswerOptions({ q }: { q: SnapshotQuestion }) {
  const [status, setStatus] = useState<"idle" | "sending">("idle");
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [freeText, setFreeText] = useState("");

  if (!q.options?.length) return null;
  if (result?.ok) {
    return <p className="pl-4 text-xs text-muted-foreground">✓ you answered: {result.answer}</p>;
  }
  if (result && !result.ok && result.reason === "already-answered") {
    return (
      <p className="pl-4 text-xs text-muted-foreground">
        Already answered{result.resolvedBy ? ` by ${result.resolvedBy}` : ""}
        {result.answeredVia ? ` via ${result.answeredVia}` : ""}: {result.answer}
      </p>
    );
  }

  async function submit(body: { chosenLabels?: string[]; freeText?: string }) {
    setStatus("sending");
    const r = await postAnswer(q.id, body);
    setResult(r);
    setStatus("idle");
  }

  function toggle(label: string) {
    if (!q.multiSelect) {
      void submit({ chosenLabels: [label] });
      return;
    }
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  const options = q.options; // narrowed above; keep the closure below simple
  return (
    <div className="flex flex-col gap-2 pl-4">
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Button
            key={o.label}
            type="button"
            size="sm"
            variant={q.multiSelect && picked.has(o.label) ? "default" : "outline"}
            disabled={status === "sending"}
            title={o.description}
            onClick={() => toggle(o.label)}
          >
            {o.label}
            {o.recommended ? <span className="ml-1 text-[10px] opacity-70">(Recommended)</span> : null}
          </Button>
        ))}
      </div>
      {options.map((o) => (
        <p key={o.label} className="text-xs text-muted-foreground">
          <span className="font-medium">{o.label}:</span> {o.description}
        </p>
      ))}
      {q.multiSelect ? (
        <Button
          type="button"
          size="sm"
          disabled={status === "sending" || picked.size === 0}
          onClick={() => void submit({ chosenLabels: [...picked] })}
        >
          Submit
        </Button>
      ) : null}
      {result && !result.ok && result.reason === "http" ? (
        <p className="text-xs text-destructive">{result.message}</p>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (freeText.trim()) void submit({ freeText: freeText.trim() });
        }}
      >
        <Input
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="something else…"
          disabled={status === "sending"}
          className="h-7 text-xs"
        />
        <Button type="submit" size="sm" variant="ghost" disabled={status === "sending" || !freeText.trim()}>
          Answer
        </Button>
      </form>
    </div>
  );
}

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
          <div key={q.id} className="mb-2 last:mb-0">
            <p>
              <span className="text-xs">
                {q.asker} · {ago(now, q.at)}
              </span>{" "}
              — {q.question}
            </p>
            {q.recommendation ? <p className="pl-4">↳ expo recommends: {q.recommendation}</p> : null}
            <AnswerOptions q={q} />
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
            <div key={q.id} className="py-1.5">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs text-muted-foreground">{q.asker}</span>
                <span className="min-w-0 flex-1">{q.question}</span>
                {q.state === "needs_human" ? <Badge variant="destructive">escalated</Badge> : null}
                <span className="shrink-0 text-xs text-muted-foreground">{ago(now, q.at)}</span>
              </div>
              {q.state === "needs_human" ? <AnswerOptions q={q} /> : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
