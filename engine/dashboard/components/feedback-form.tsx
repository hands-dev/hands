import { useState } from "react";
import { cn } from "@/lib/utils";

type Status = "idle" | "sending" | "sent" | "error";

/**
 * A thin wrapper around the same GitHub-issue filing the /hands:feedback
 * skill does (POST /api/feedback → engine/src/feedback.ts's fileFeedback,
 * the one shared implementation) — just reachable from the dashboard
 * instead of chat. Collapsed by default; expands inline in the sidebar
 * rather than a modal, keeping this POC-tier addition to one small
 * component with no new UI primitives.
 */
export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || status === "sending") return;
    setStatus("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, title: title.trim() || undefined }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (res.ok && data.url) {
        setStatus("sent");
        setMessage(data.url);
        setBody("");
        setTitle("");
      } else {
        setStatus("error");
        setMessage(data.error ?? "something went wrong");
      }
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-dashed px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        Send feedback
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border bg-card p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-card-foreground">Send feedback</span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setStatus("idle");
            setMessage(null);
          }}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        className="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Bug, rough edge, wish…"
        rows={4}
        required
        className="resize-none rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <button
        type="submit"
        disabled={status === "sending" || !body.trim()}
        className={cn(
          "rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90",
          (status === "sending" || !body.trim()) && "cursor-not-allowed opacity-50",
        )}
      >
        {status === "sending" ? "Sending…" : "Send"}
      </button>
      {status === "sent" && message && (
        <a href={message} target="_blank" rel="noreferrer" className="truncate text-heard underline">
          Filed → {message}
        </a>
      )}
      {status === "error" && message && <span className="text-destructive">{message}</span>}
    </form>
  );
}
