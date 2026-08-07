import { marked } from "marked";

/**
 * Craft note bodies and book/skill content are self-authored by the viewer's own local Claude
 * Code sessions — not remote/untrusted input — but `marked` passes raw HTML straight through by
 * default. Escaping angle brackets/ampersands before parsing is a cheap, effective mitigation
 * against that passthrough without pulling in a full sanitizer for a single-player, local-only
 * surface.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One-line note bodies (mise/book/skill/friction/spillover entries) — no block wrapping. */
export function renderInline(text: string): string {
  return marked.parseInline(escapeHtml(text), { async: false }) as string;
}

/** Full book/mise/skill documents — headings, lists, code fences. */
export function renderBlock(text: string): string {
  return marked.parse(escapeHtml(text), { async: false }) as string;
}
