import { Panel } from "@/components/panel";

export function Specials({ items }: { items: string[] }) {
  return (
    <Panel title="Today's specials">
      {items.length === 0 ? (
        <p className="py-1 text-[13px] text-muted-foreground">
          Not set — the expo will ask for them.
        </p>
      ) : (
        <ol className="space-y-1">
          {items.map((item, i) => (
            <li key={item} className="flex gap-2 text-[13px]">
              <span className="shrink-0 font-mono text-[11px] font-semibold text-heat">
                P{i + 1}
              </span>
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
