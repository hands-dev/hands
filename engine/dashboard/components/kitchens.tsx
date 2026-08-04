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
import type { OtherKitchen } from "../../src/remote.js";

/**
 * Multiplayer: other handles reporting to the same books repo. Renders
 * nothing when the books are off or nobody else has written.
 */
export function OtherKitchens({ kitchens, now }: { kitchens: OtherKitchen[]; now: number }) {
  if (kitchens.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Other kitchens</CardTitle>
        <CardDescription>Everyone else on these books</CardDescription>
        <CardAction>
          <Badge variant="secondary">{kitchens.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="max-h-96 overflow-auto text-sm">
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
