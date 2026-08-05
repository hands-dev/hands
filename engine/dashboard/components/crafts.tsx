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
import type { OtherCraft } from "../../src/remote.js";

/** First non-empty line, code-point-safe, for a book/skill preview. */
function firstLine(text: string, max = 160): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const points = Array.from(line);
  return points.length <= max ? line : `${points.slice(0, max - 1).join("")}…`;
}

/** One handle's crafts, grouped for the "other kitchens' crafts" panel. */
interface HandleCrafts {
  handle: string;
  crafts: OtherCraft[];
}

function groupByHandle(crafts: OtherCraft[]): HandleCrafts[] {
  const byHandle = new Map<string, OtherCraft[]>();
  for (const c of crafts) {
    const list = byHandle.get(c.handle);
    if (list) list.push(c);
    else byHandle.set(c.handle, [c]);
  }
  return [...byHandle.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([handle, list]) => ({ handle, crafts: list.sort((a, b) => a.slug.localeCompare(b.slug)) }));
}

/**
 * Multiplayer: other handles' crafts (prep book + craft skill) in the same
 * books repo — a teammate's equivalent craft, browsable for inspiration.
 * Renders nothing when the books are off or nobody else has a craft yet.
 */
export function OtherCrafts({ crafts }: { crafts: OtherCraft[] }) {
  if (crafts.length === 0) return null;
  const handles = groupByHandle(crafts);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Other kitchens' crafts</CardTitle>
        <CardDescription>Prep books and craft skills from across the books</CardDescription>
        <CardAction>
          <Badge variant="secondary">{crafts.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="max-h-96 overflow-auto text-sm">
        {handles.map(({ handle, crafts: handleCrafts }, i) => (
          <div key={handle}>
            {i > 0 ? <Separator className="my-2" /> : null}
            <div className="flex items-center gap-2">
              <span className="font-medium">{handle}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {handleCrafts.length === 1 ? "1 craft" : `${handleCrafts.length} crafts`}
              </span>
            </div>
            {handleCrafts.map((c) => (
              <div key={c.slug} className="py-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{c.slug}</Badge>
                  {!c.book ? <span className="text-xs text-muted-foreground">no book</span> : null}
                  {!c.skill ? <span className="text-xs text-muted-foreground">no skill</span> : null}
                </div>
                {c.book ? (
                  <p className="min-w-0 truncate text-muted-foreground" title={c.book}>
                    {firstLine(c.book)}
                  </p>
                ) : null}
                {c.skill ? (
                  <p className="min-w-0 truncate text-muted-foreground" title={c.skill}>
                    {firstLine(c.skill)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
