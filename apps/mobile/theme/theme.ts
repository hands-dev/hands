import tokens from "./tokens.json";

/**
 * React Native has no CSS/Tailwind — brand/tokens/tokens.json (the same file
 * BRAND.md points at for every other platform) is consumed as plain data
 * here instead of transcribing hex values by hand (hands#107). Vendored via
 * a plain copy, same reasoning as types/hands-snapshot.d.ts: apps/mobile
 * has no workspace link back to brand/, so a committed, regenerate-on-demand
 * copy is the whole mechanism — see the README for how to refresh it.
 */
export const colors = {
  ink: tokens.neutral.ink,
  paper: tokens.neutral.paper,
  surface: tokens.neutral.surface,
  line: tokens.neutral.line,
  muted: tokens.neutral.muted,
  accent: tokens.accent.pivot,
  accentOnLight: tokens.accent.onLight,
} as const;

/** Station 1-5 hex, in order — palette is capped at 5 per BRAND.md §4. */
export const stationPalette = Object.values(tokens.palette)
  .sort((a, b) => a.station - b.station)
  .map((p) => p.hex);

/** `station-<n>` → its palette hex; falls back to `colors.muted` past 5 or for non-station ids (e.g. "expo"). */
export function stationColor(stationId: string): string {
  const m = /^station-(\d+)$/.exec(stationId);
  if (!m) return colors.muted;
  const index = Number.parseInt(m[1]!, 10) - 1;
  return stationPalette[index] ?? colors.muted;
}

export const fonts = {
  // family names as registered by @expo-google-fonts/* useFonts() below —
  // not the same strings as BRAND.md's CSS values ("Archivo 700" etc.)
  wordmark: "Archivo_700Bold",
  ui: "Archivo_400Regular",
  uiMedium: "Archivo_500Medium",
  mono: "JetBrainsMono_400Regular",
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
