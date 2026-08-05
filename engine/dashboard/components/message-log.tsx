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
import type { SnapshotMessage } from "../../src/snapshot.js";

/**
 * Live who/to/summary view of the bus's directed + broadcast MCP messages
 * (hands#58) — the same trailing window buildSnapshot already collects for
 * the pass, just never rendered until now. Full body is a hover tooltip
 * (mirrors JournalFeed's truncate+title pattern) rather than a click-to-
 * expand affordance — no new interaction pattern for this dashboard.
 */
export function MessageLog({ messages, now }: { messages: SnapshotMessage[]; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP messages</CardTitle>
        <CardDescription>Who sent what to whom, across expo/stations/books</CardDescription>
        <CardAction>
          <Badge variant="secondary">{messages.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="max-h-80 overflow-auto text-sm">
        {messages.length === 0 ? (
          <p className="text-muted-foreground">No messages yet.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="flex items-center gap-2 py-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">
                {m.from} → {m.to === "*" ? "all" : m.to}
              </span>
              <span className="min-w-0 flex-1 truncate" title={m.body}>
                {m.subject ?? m.body}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{ago(now, m.at)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
