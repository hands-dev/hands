import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface MenuItem {
  slug: string;
  title: string | null;
  rank: number | null;
  criteriaDone: number;
  criteriaTotal: number;
}

/**
 * hands#96/#137: replaces the old flat-string Specials panel. Minimal wiring for the new
 * recipe-backed menu — ranked list, title, criteria progress. A richer per-recipe view (full
 * description, the acceptance-criteria checklist itself) is deliberately NOT built here; that's
 * named follow-up scope (see the #96 PR), not silently folded into this data-model swap.
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
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
