import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function Specials({ items }: { items: string[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Today's specials</CardTitle>
        <CardDescription>The day's priorities, ranked</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {items.length === 0 ? (
          <p className="text-muted-foreground">Not set — the expo will ask for them.</p>
        ) : (
          <ol className="space-y-2">
            {items.map((item, i) => (
              <li key={item} className="flex items-start gap-2">
                <Badge variant="outline">P{i + 1}</Badge>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
