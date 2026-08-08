# Hands — brand system

**A French kitchen brigade for coding agents.**
Structure, not swarm. · If it's not on the books, it didn't happen.

---

## 1. The mark

A left hand, palm out: five upright strokes on one baseline with a coloured dot at
each fingertip. Pinky to thumb, left to right.

**Grid** (100 × 100 viewBox)

| finger  | x  | tip y | length | ratio to middle |
|---------|----|-------|--------|-----------------|
| pinky   | 19 | 42.5  | 33.5   | 0.54 |
| ring    | 34 | 23.5  | 52.5   | 0.85 |
| middle  | 49 | 14    | 62     | 1.00 |
| pointer | 64 | 20    | 56     | 0.90 |
| thumb   | 79 | 63.5  | 12.5   | 0.20 |

- Baseline **y = 76** for all five. Pitch **P = 15** between strokes.
- Stroke width **9**, round caps. Dot radius **4.5** — exactly half the stroke width,
  so no nail overhangs its finger.
- Optical bounds **14.5–83.5 × 9.5–80.5** (69 × 71). Align to these, never the 100 × 100 box.
- Lengths are traced from a drawn reference, not derived from a formula. Do not "tidy" them.

**Colour behaviour.** Strokes inherit `currentColor`, so one file works on light and dark.
Nails are `--hands-nail-1` … `--hands-nail-5`, left to right, thumb last.

**Mono variant** (`hands-mark-mono.svg`) puts the nails in `currentColor` too. Use it below
24 px and anywhere the palette can't be trusted.

---

## 2. Wordmark

**Archivo 700**, always lowercase, never caps.

Kerning is set per pair, not by uniform tracking. Values in units at font-size 76:

    ha −2.3   ·   an −1.6   ·   nd −2.3   ·   ds −3.0

`an` is stem-to-stem and already tight, so it takes the least. `ds` opens the biggest
hole — straight stem against the s spine — so it takes the most. Total closure equals a
uniform −0.03em, so the width is unchanged; only the rhythm differs. Scale the dx values
linearly with font size.

---

## 3. Lockups

**Horizontal** (primary) — site header, README, docs. Minimum width **120 px**.
Mark scaled **0.835** to the wordmark's ascender height; its optical floor sits 0.5 below
the type baseline. Gap mark → wordmark = P × 0.835.

**Stacked** — square crops, stickers, slides, avatars. Minimum width **88 px**.
Mark at full size, wordmark cap top one P below the mark's floor.

**Mark only** — favicon, CLI splash, plugin tile.

**Clear space** — P on all four sides, where P = 21% of mark height.
At 48 px mark height, P = 10 px.

### Don't
- Recolour the strokes to a nail hue. Strokes are ink; nails are colour.
- Re-order or re-sample the palette. Left to right, thumb last.
- Set the wordmark in caps, or place a tagline inside the clear space.
- Put the mark on a mid-tone photo without the near-black plate.

---

## 4. Palette

Five hues, one per station. Tuned for dark ground first, because the terminal is the
hardest surface — every hue clears 5.6:1 on `#0B0B0C`, so all five are safe for status
text without a per-case audit. On white they are display colours only.

| # | name   | hex       | on #FFFFFF | on #0B0B0C | role |
|---|--------|-----------|-----------|-----------|------|
| 1 | aqua   | `#00E0C6` | 1.68 | 12.48 | station 1 · info |
| 2 | cobalt | `#4D7CFF` | 3.72 |  5.64 | station 2 · running |
| 3 | orchid | `#B85CFF` | 3.49 |  6.01 | station 3 · queued · **accent pivot** |
| 4 | coral  | `#FF5C7A` | 2.97 |  7.06 | station 4 · failed |
| 5 | amber  | `#FFB020` | 1.83 | 11.48 | station 5 · warning |

### Site chrome — two tokens

| token | hex | notes |
|-------|-----|-------|
| `--hands-accent` | `#B85CFF` | ≥3:1 on both grounds. Borders, focus rings, icons, headline type. Body-safe on dark (6.01). |
| `--hands-accent-on-light` | `#7A28C9` | 7.06:1 on white. Accent body text and links on paper. |

### Neutrals

    ink      #0B0B0C      paper    #F4F3F1
    surface  #141416      line     #242427      muted  #8A8884

Cap concurrent stations at five. A sixth reuses station 1 with a dim or stripe modifier —
five is the mark, and the mark is the legend.

---

## 5. Type

| role | face |
|------|------|
| Wordmark | Archivo 700 |
| Display & UI | Archivo |
| Code, data, labels | JetBrains Mono |

---

## 6. Files

    logo/     mark (colour + mono), horizontal and stacked lockups — SVG source
    web/      favicon.ico (16 mono / 32 / 48 colour), PNG icons, maskable,
              safari-pinned-tab.svg, site.webmanifest, head-snippet.html
    ios/      AppIcon.appiconset with Contents.json — drop into Xcode
    android/  mipmap-*/ic_launcher.png, adaptive foreground + background, Play 512
    social/   og-image.png (1200×630), twitter-card.png, og-image-light.png (1200×630),
              github-avatar-512.png
    tokens/   CSS, SCSS, JSON, Swift, Android XML, Tailwind, TUI/ANSI table

`og-image.png` is the default (dark) — use it unless a surface is known to render OG images
on a light background, where `og-image-light.png` avoids a dark card floating on white.

### Favicon note
At 16 px each nail is ~2 device px; five hues inside 2 px land within a couple of 8-bit
steps of one another after downsampling, so the palette reads as dirt rather than colour.
**16 is mono. 32 and 48 carry the full palette** — an ICO stores each size independently,
and retina tabs, the bookmarks bar, and the history dropdown all pull the larger entries.

Every icon tile carries the near-black plate rather than transparency: the mark is five
thin strokes, and light browser chrome eats them on a transparent icon.

### Lockup SVGs
These ship with live `<text>` so the kerning stays editable. **Convert to outlines at final
handoff** — they need Archivo installed otherwise. The mark SVGs are outline-only and
need no fonts.
