import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtTokens } from "@/lib/format";
import type { DashboardPayload } from "../../src/serve.js";

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        <CardDescription className="text-xs">{hint}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export function StatCards({ snapshot }: { snapshot: DashboardPayload }) {
  const live = snapshot.tasks.filter((t) => t.state !== "done" && t.state !== "cancelled");
  const returned = snapshot.tasks.filter((t) => t.state === "returned").length;
  const onDuty = snapshot.agents.filter((a) => a.online).length;
  const wakesH = snapshot.agents.reduce((n, a) => n + a.wakesLastHour, 0);
  const wakes24 = snapshot.agents.reduce((n, a) => n + a.wakes24h, 0);
  const totals = Object.values(snapshot.tokens?.totals24h ?? {});
  const out24 = totals.reduce((n, t) => n + t.out, 0);
  const cache24 = totals.reduce((n, t) => n + t.cacheRead, 0);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat label="On the rail" value={String(live.length)} hint={`${returned} at the pass`} />
      <Stat
        label="On duty"
        value={`${onDuty}/${snapshot.agents.length}`}
        hint="panes online"
      />
      <Stat label="Wakes" value={`${wakesH}/h`} hint={`${wakes24} in 24h`} />
      <Stat
        label="Token burn 24h"
        value={fmtTokens(out24)}
        hint={`output · ${fmtTokens(cache24)} cache-read`}
      />
    </div>
  );
}
