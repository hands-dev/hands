import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ChatEvent } from "../../src/chat.js";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  error?: string;
}

/**
 * Parses the /api/chat SSE body into ChatEvents. Not EventSource — this is a
 * one-shot stream per question, not a subscription, so a plain fetch() +
 * reader is simpler than standing up an EventSource per turn.
 */
async function* readChatEvents(response: Response): AsyncGenerator<ChatEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          yield JSON.parse(line.slice("data: ".length)) as ChatEvent;
        } catch {
          // malformed frame — skip rather than kill the stream
        }
      }
    }
  }
}

/** Honest placeholder — see chat.ts's hasAgentSdkInstalled for exactly why. */
function ChatUnavailable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask</CardTitle>
        <CardDescription>Not available in this install</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        The dashboard chat needs the Claude Agent SDK, a dev-checkout-only dependency — its
        platform package vendors a ~280MB copy of the <code>claude</code> CLI binary, which can't
        be bundled into the plugin's committed, npm-install-free dist. Run hands from a source
        checkout with <code>npm install</code> done in <code>engine/</code> to enable it.
      </CardContent>
    </Card>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const outbound = message.role === "user";
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-sm",
          outbound ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {message.text || (message.error ? null : "…")}
        {message.error ? <div className="text-destructive">{message.error}</div> : null}
      </div>
    </div>
  );
}

let nextId = 1;

export function ChatPanel({ chatAvailable }: { chatAvailable: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [tool, setTool] = useState<string | null>(null);
  const sessionId = useRef<string | undefined>(undefined);

  if (!chatAvailable) return <ChatUnavailable />;

  async function send() {
    const prompt = input.trim();
    if (!prompt || sending) return;
    setInput("");
    setSending(true);
    setTool(null);
    setMessages((prev) => [...prev, { id: nextId++, role: "user", text: prompt }]);
    const assistantId = nextId++;
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", text: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, sessionId: sessionId.current }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, error: data?.error ?? `HTTP ${res.status}` } : m)),
        );
        return;
      }
      for await (const event of readChatEvents(res)) {
        if (event.type === "text") {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + event.text } : m)));
        } else if (event.type === "tool") {
          setTool(event.name);
        } else if (event.type === "done") {
          if (event.sessionId) sessionId.current = event.sessionId;
          if (event.error) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, error: event.error } : m)));
          }
        } else if (event.type === "unavailable") {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, error: "chat isn't available in this install" } : m)),
          );
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, error: err instanceof Error ? err.message : String(err) } : m,
        ),
      );
    } finally {
      setTool(null);
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask</CardTitle>
        <CardDescription>Read-only — hands_board, hands_tasks, hands_peers, and friends</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex max-h-[28rem] min-h-[8rem] flex-col gap-2 overflow-auto">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ask about what the kitchen's working on.</p>
          ) : (
            messages.map((m) => <Bubble key={m.id} message={m} />)
          )}
          {tool ? <p className="text-xs text-muted-foreground italic">checking {tool}…</p> : null}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What's blocking ticket #109?"
            disabled={sending}
          />
          <Button type="submit" disabled={sending || !input.trim()}>
            {sending ? "Asking…" : "Ask"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
