import { cn } from "@/lib/utils";

/**
 * The Hands mark — a left hand, palm out, five strokes with a coloured dot
 * at each fingertip (~/Desktop/brand/BRAND.md §1). Strokes are `currentColor`
 * (set `text-*` on the wrapper to recolor them); nails read `--hands-nail-1..5`
 * (styles.css), one hue per station, left to right, thumb last.
 */
export function HandsMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" role="img" aria-label="Hands" className={cn("size-6", className)}>
      <g fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round">
        <path d="M19 76 V42.5" />
        <path d="M34 76 V23.5" />
        <path d="M49 76 V14" />
        <path d="M64 76 V20" />
        <path d="M79 76 V63.5" />
      </g>
      <circle cx="19" cy="42.5" r="4.5" fill="var(--hands-nail-1)" />
      <circle cx="34" cy="23.5" r="4.5" fill="var(--hands-nail-2)" />
      <circle cx="49" cy="14" r="4.5" fill="var(--hands-nail-3)" />
      <circle cx="64" cy="20" r="4.5" fill="var(--hands-nail-4)" />
      <circle cx="79" cy="63.5" r="4.5" fill="var(--hands-nail-5)" />
    </svg>
  );
}

/** Horizontal lockup — mark + lowercase wordmark, BRAND.md §2/§3 (site header context). */
export function HandsWordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-foreground", className)}>
      <HandsMark className="size-5" />
      <span className="font-sans text-base font-bold tracking-tight">hands</span>
    </div>
  );
}
