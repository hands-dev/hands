import type * as React from "react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * App-level composition over the stock Card: the docket header (small-caps
 * mono title + right-aligned count) and rail density live HERE, never in the
 * vendored shadcn primitives.
 */
export function Panel({
  title,
  action,
  className,
  contentClassName,
  children,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("gap-2 rounded-lg py-3 shadow-none", className)}>
      <CardHeader className="px-4">
        <CardTitle className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {title}
        </CardTitle>
        {action !== undefined ? (
          <CardAction className="font-mono text-[11px] text-muted-foreground">{action}</CardAction>
        ) : null}
      </CardHeader>
      <CardContent className={cn("px-4", contentClassName)}>{children}</CardContent>
    </Card>
  );
}

/** The docket badge look, applied to the stock Badge via className. */
export const chip = "rounded-sm px-1.5 py-0 font-mono text-[10.5px] uppercase tracking-wide";
