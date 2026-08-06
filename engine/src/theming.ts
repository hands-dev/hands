import * as os from "node:os";
import * as path from "node:path";

/**
 * Deterministic-by-station-index theme assignment (hands#104).
 *
 * Claude Code already supports custom themes as standalone files under
 * `~/.claude/themes/<name>.json`, selected per-directory via that worktree's
 * `.claude/settings.local.json` (`{ "theme": "custom:<name>" }`) — the
 * mechanism is proven, hands just didn't own it. This module is the single
 * place that decides station index → colour, so the mapping stays stable
 * across `hands scale` up/down and across re-creation: station-3 is always
 * the same colour, in every repo, forever (until someone edits the palette).
 *
 * Deliberately NOT random and NOT insertion-order-dependent — both would
 * make the mapping a human learns stop meaning anything the moment a
 * station gets retired and a new one takes a lower index.
 */
export interface ThemeColor {
  /** short, human-facing colour name — folded into the session name and theme file's own "name" */
  name: string;
  /** hex used for both `claude` and `promptBorder` overrides */
  hex: string;
}

/**
 * Eight hand-picked, readably-distinct hues for a dark theme base. Beyond
 * index 8 the palette wraps (station-9 reuses station-1's colour) — same
 * "fold to a shared colour past N" tradeoff the dashboard's own chart
 * palette already makes (see dashboard/lib/series.ts), just with a longer
 * runway since seven-plus concurrently open stations is already a lot of
 * panes for one human to track.
 */
export const THEME_PALETTE: readonly ThemeColor[] = [
  { name: "blue", hex: "#4a9eff" },
  { name: "amber", hex: "#f5a623" },
  { name: "violet", hex: "#9b59f6" },
  { name: "teal", hex: "#2dd4bf" },
  { name: "rose", hex: "#fb7185" },
  { name: "lime", hex: "#a3e635" },
  { name: "orange", hex: "#fb923c" },
  { name: "sky", hex: "#38bdf8" },
];

/** Station index (1-based) → palette colour. Wraps past THEME_PALETTE.length. */
export function themeColorForIndex(index: number): ThemeColor {
  const n = THEME_PALETTE.length;
  const i = ((index - 1) % n + n) % n;
  return THEME_PALETTE[i]!;
}

/** The `<name>` in `~/.claude/themes/<name>.json` / `custom:<name>` — unique per repo + station. */
export function themeFileName(repoSlug: string, index: number): string {
  return `${repoSlug}-station-${index}`;
}

/** `~/.claude/themes/` — same HANDS_TEST_HOME override as config.ts/credentials.ts/projects.ts. */
export function themesDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HANDS_TEST_HOME?.trim() || os.homedir();
  return path.join(home, ".claude", "themes");
}

export function themeFilePath(repoSlug: string, index: number, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(themesDir(env), `${themeFileName(repoSlug, index)}.json`);
}

export interface StationThemeAssignment {
  index: number;
  color: ThemeColor;
  /** absolute path of the theme file this assignment owns */
  file: string;
  /** the `theme` value to write into the worktree's settings.local.json */
  themeId: string;
  /**
   * hands-owned display label — used as both the theme file's own "name"
   * field and the session name pushed via `/rename` + shown on the
   * dashboard, so the pane, its chrome, and its board row all read as the
   * same agent (hands#104's whole point).
   */
  sessionName: string;
}

/**
 * Compute (never writes anything) the full theme assignment for a station.
 * `repoLabel` is the human-facing project name (repo dir basename); `repoSlug`
 * is the coordination-dir slug (basename + hash) — unique across repos with
 * the same basename on one machine, so the theme file itself never collides.
 */
export function assignStationTheme(opts: {
  repoLabel: string;
  repoSlug: string;
  index: number;
  env?: NodeJS.ProcessEnv;
}): StationThemeAssignment {
  const color = themeColorForIndex(opts.index);
  const name = themeFileName(opts.repoSlug, opts.index);
  return {
    index: opts.index,
    color,
    file: themeFilePath(opts.repoSlug, opts.index, opts.env),
    themeId: `custom:${name}`,
    sessionName: `${opts.repoLabel} · station-${opts.index} (${color.name})`,
  };
}

/** The theme file's own JSON contents — Claude Code's standalone custom-theme format. */
export function themeFileContents(assignment: StationThemeAssignment): Record<string, unknown> {
  return {
    name: assignment.sessionName,
    base: "dark",
    overrides: { claude: assignment.color.hex, promptBorder: assignment.color.hex },
  };
}
