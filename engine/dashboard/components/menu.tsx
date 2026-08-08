import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface MenuItem {
  slug: string;
  title: string | null;
  rank: number | null;
  criteriaDone: number;
  criteriaTotal: number;
  /** hands#116 — how many currently-active criteria have a grade, and how many of those are "met". Can disagree with criteriaDone/criteriaTotal — that's the point, not a bug. */
  gradedCriteria: number;
  metCriteria: number;
}

/**
 * hands#96/#137: replaces the old flat-string Specials panel. Minimal wiring for the new
 * recipe-backed menu — ranked list, title, criteria progress. A richer per-recipe view (full
 * description, the acceptance-criteria checklist itself) is deliberately NOT built here; that's
 * named follow-up scope (see the #96 PR), not silently folded into this data-model swap.
 *
 * hands#116: criteriaDone/criteriaTotal is the recipe's own markdown checkboxes — the principal's
 * informal signal. gradedCriteria/metCriteria is the sous's (or whoever grades) formal verdict.
 * Shown side by side, never merged into one number — when they disagree (a criterion checked off
 * but graded not_met, say), that disagreement is the useful thing to see here, not something this
 * component should reconcile or hide.
 */
export function Menu({ items }: { items: MenuItem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Today's menu</CardTitle>
        <CardDescription>Recipes in play, ranked</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {items.length === 0 ? (
          <p className="text-muted-foreground">Not set — the expo will ask for it.</p>
        ) : (
          <ol className="space-y-2">
            {items.map((item, i) => (
              <li key={item.slug} className="flex items-start gap-2">
                <Badge variant="outline">#{item.rank ?? i + 1}</Badge>
                <span className="min-w-0">
                  {item.title ?? item.slug}
                  {item.criteriaTotal > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({item.criteriaDone}/{item.criteriaTotal} criteria)
                    </span>
                  )}
                  {item.gradedCriteria > 0 && (
                    <span className="text-muted-foreground">
                      {" · "}graded {item.metCriteria}/{item.gradedCriteria} met
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
