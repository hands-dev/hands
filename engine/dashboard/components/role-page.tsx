import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { fmtDuration } from "@/lib/format";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { SnapshotAgent, SnapshotMessage } from "../../src/snapshot.js";

function StateDot({ state }: { state: SnapshotAgent["state"] }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        state === "active" && "bg-heard",
        state === "idle" && "bg-amber-500",
        state === "offline" && "bg-muted-foreground/30",
      )}
    />
  );
}

function RoleHeader({ agent, now }: { agent: SnapshotAgent; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <StateDot state={agent.state} />
          {agent.id}
        </CardTitle>
        <CardDescription>
          {agent.focus ?? "no focus set"} · {agent.online ? "online" : `last seen ${ago(now, agent.lastSeen)}`}
        </CardDescription>
        <CardAction>
          <Badge variant="outline" className="text-xs">
            {agent.wakesLastHour}/h · {agent.wakes24h}/24h wakes
          </Badge>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

/**
 * Ack/turnaround status — only for outbound, non-broadcast bubbles, the standard read-receipt
 * convention (you don't ack your own sent message; you see whether the OTHER side acked it).
 * "Acked" here means the recipient's own hands_receive first drained it — the closest honest
 * equivalent to a read receipt this bus has (see Store.ackMessages). Unacked grows live for
 * free: `now` already ticks forward on every SSE push, no separate timer needed.
 */
function AckStatus({ message, now }: { message: SnapshotMessage; now: number }) {
  if (message.ackedAt != null) {
    return (
      <span className="text-heard" title={`acked ${new Date(message.ackedAt).toLocaleTimeString()}`}>
        ✓ {fmtDuration(message.ackedAt - message.at)}
      </span>
    );
  }
  return <span>awaiting ack · {fmtDuration(Math.max(0, now - message.at))}</span>;
}

function ChatBubble({
  message,
  agentId,
  now,
  onSelectRole,
}: {
  message: SnapshotMessage;
  agentId: string;
  now: number;
  onSelectRole: (agentId: string) => void;
}) {
  const outbound = message.from === agentId;
  const other = outbound ? message.to : message.from;
  const broadcast = other === "*";
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2",
          outbound ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1.5 text-xs",
            outbound ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          {broadcast ? (
            <span>all</span>
          ) : (
            <button type="button" onClick={() => onSelectRole(other)} className="underline-offset-2 hover:underline">
              {other}
            </button>
          )}
          <span>· {ago(now, message.at)}</span>
        </div>
        {message.subject ? <div className="text-sm font-medium">{message.subject}</div> : null}
        <div className="text-sm">{message.body}</div>
        {outbound && !broadcast ? (
          <div className="mt-1 flex items-center gap-1 text-xs text-primary-foreground/70">
            <AckStatus message={message} now={now} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** This agent's message history, as a chat thread — oldest first, bubbles aligned by direction. */
function RoleMessages({
  agentId,
  messages,
  now,
  onSelectRole,
}: {
  agentId: string;
  messages: SnapshotMessage[];
  now: number;
  onSelectRole: (agentId: string) => void;
}) {
  const chronological = [...messages].reverse(); // messages arrives newest-first; a thread reads top-down
  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP messages</CardTitle>
        <CardDescription>Everything {agentId} sent or received</CardDescription>
        <CardAction>
          <Badge variant="secondary">{messages.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex max-h-96 flex-col gap-2 overflow-auto">
        {chronological.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          chronological.map((m) => (
            <ChatBubble key={m.id} message={m} agentId={agentId} now={now} onSelectRole={onSelectRole} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Honest placeholder, not fake data — neither monitor history (which .notify wake fired why) nor
 * a per-tool usage breakdown is tracked anywhere in this codebase yet. wake_log only counts that
 * a wake was delivered, no cause reference; nothing parses which tools an agent called. Both need
 * new instrumentation this pass doesn't build.
 */
function NotTrackedYet() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monitor history &amp; tool usage</CardTitle>
        <CardDescription>Not tracked yet</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Neither what triggered this pane's wakes nor a per-tool call breakdown is recorded
        anywhere today — this needs new instrumentation, not yet built.
      </CardContent>
    </Card>
  );
}

export function RolePage({
  agent,
  messages,
  now,
  onSelectRole,
}: {
  agent: SnapshotAgent;
  messages: SnapshotMessage[];
  now: number;
  onSelectRole: (agentId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <RoleHeader agent={agent} now={now} />
      <RoleMessages agentId={agent.id} messages={messages} now={now} onSelectRole={onSelectRole} />
      <NotTrackedYet />
    </div>
  );
}
