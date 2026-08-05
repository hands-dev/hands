import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ago } from "@/lib/time";
import type { BooksSyncStatus } from "../../src/serve.js";
import type { OtherKitchen } from "../../src/remote.js";

const REASON_LABEL: Record<NonNullable<BooksSyncStatus["reason"]>, string> = {
  offline: "offline",
  conflict: "rebase conflict",
  error: "sync error",
};

/** "synced 2m ago" / "sync failing (offline) — last ok 14m ago" / "never synced" */
function SyncStatusLine({ status, now }: { status: BooksSyncStatus; now: number }) {
  if (status.ok && status.lastSuccess != null) {
    return <span className="text-xs text-muted-foreground">synced {ago(now, status.lastSuccess)}</span>;
  }
  if (!status.ok) {
    const reason = status.reason ? REASON_LABEL[status.reason] : "sync error";
    const lastOk = status.lastSuccess != null ? `last ok ${ago(now, status.lastSuccess)}` : "never synced";
    return (
      <span className="text-xs text-destructive">
        sync failing ({reason}) — {lastOk}
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">not synced yet</span>;
}

/**
 * Multiplayer: other handles reporting to the same books repo. Renders
 * nothing when the books aren't configured at all (booksSync null); once
 * configured, always renders — even with zero other kitchens — so a sync
 * that's silently failing looks different from "nobody else has written"
 * (hands#59).
 */
export function OtherKitchens({
  kitchens,
  booksSync,
  now,
}: {
  kitchens: OtherKitchen[];
  booksSync: BooksSyncStatus | null;
  now: number;
}) {
  if (!booksSync) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Other kitchens</CardTitle>
        <CardDescription className="flex items-center gap-2">
          <span>Everyone else on these books</span>
          <SyncStatusLine status={booksSync} now={now} />
        </CardDescription>
        <CardAction>
          <Badge variant="secondary">{kitchens.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="max-h-96 overflow-auto text-sm">
        {kitchens.length === 0 ? (
          <p className="text-muted-foreground">No other kitchens on these books yet.</p>
        ) : null}
        {kitchens.map((kitchen, i) => (
          <div key={kitchen.handle}>
            {i > 0 ? <Separator className="my-2" /> : null}
            <div className="flex items-center gap-2">
              <span className="font-medium">{kitchen.handle}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {kitchen.lastTs ? `last activity ${ago(now, kitchen.lastTs)}` : "no activity yet"}
              </span>
            </div>
            {kitchen.updates.map((u) => (
              <div key={`${u.ts}·${u.type}·${u.summary}`} className="flex items-center gap-2 py-1">
                {u.agent ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{u.agent}</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate" title={u.summary}>
                  {u.summary}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{ago(now, u.ts)}</span>
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
