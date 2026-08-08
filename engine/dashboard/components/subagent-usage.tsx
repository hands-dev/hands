import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtTokens } from "@/lib/format";

export interface SubagentUsageRow {
  agentType: string;
  calls: number;
  totalOutputTokens: number;
  avgOutputTokens: number;
}

/**
 * hands#103c — subagent_samples has been written on every sub-agent finish
 * since the SubagentStop hook landed, but nothing ever read it back except a
 * craft-scoped slice on the Crafts tab. This is the whole table: which
 * agents actually get used, and at what cost per call — "is a craft earning
 * its place in the roster, or has it been defined and never fired" (#103's
 * own framing). A 7-day window, same as the table's own retention.
 */
export function SubagentUsage({ rows }: { rows: SubagentUsageRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sub-agent usage</CardTitle>
          <CardDescription>Which agent types actually get dispatched, and at what cost</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No sub-agent completions recorded yet — the first one lands after a dispatched agent finishes.
        </CardContent>
      </Card>
    );
  }
  const maxCalls = Math.max(...rows.map((r) => r.calls));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sub-agent usage</CardTitle>
        <CardDescription>Which agent types actually get dispatched, and at what cost · last 7 days</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.agentType} className="flex items-center gap-2 text-sm">
              <span className="w-40 shrink-0 truncate font-mono text-xs">{r.agentType}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(4, (r.calls / maxCalls) * 100)}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {r.calls} call{r.calls === 1 ? "" : "s"}
              </span>
              <span className="w-28 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {fmtTokens(r.avgOutputTokens)} avg
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
