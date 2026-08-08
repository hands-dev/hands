# hands mobile

A read-only React Native client for a local `hands serve` instance (hands#107). Free tier: no
authentication, no writes — it connects to a kitchen you're already running and shows the rail,
the line, and what needs the principal, live.

## Naming hazard

React Native's tooling is **Expo** (Expo Go, `expo-*` packages, `@expo-google-fonts/*`). hands has
an agent role called **the expo** (lowercase, the expeditor at the pass). This app never talks to
that expo — it only reads a local `hands serve` HTTP/SSE endpoint. Convention used throughout this
directory: **"Expo"** (capitalized) always means the React Native tooling; **"the expo"**
(lowercase, in prose) means the hands bus role.

## Platform choices, and why

- **Expo (React Native), not bare RN.** Zero native scaffolding needed for a walking skeleton,
  and Expo Go makes "run this on your phone" a QR-code scan — the natural demo path for a
  read-only free tier.
- **`react-native-sse` for the SSE client**, not a hand-rolled `EventSource`. RN has no native
  `EventSource`. Verified from its source (`node_modules/react-native-sse/src/EventSource.js`)
  before relying on it: it auto-reconnects via a polling timer (default 5s) whenever the
  underlying XHR reaches `DONE`. That timer is a `setTimeout`, and RN suspends JS execution while
  backgrounded — a phone locking mid-connection doesn't get a graceful retry from the library
  alone. `lib/useHandsStream.ts` adds an `AppState` listener that tears down and opens a fresh
  connection on every foreground transition, rather than trusting whatever state the old one
  silently ended up in.
- **React Navigation (bottom tabs)** for the 4-screen skeleton (Rail, Line, Needs you, Settings) —
  standard, well-supported, nothing fancier needed yet.
- **Tokens port, components don't port.** React Native has no CSS/Tailwind. `theme/tokens.json` is
  a plain copy of `brand/tokens/tokens.json` (the same file BRAND.md points every other platform
  at), consumed as data in `theme/theme.ts` — colors, station palette, spacing. `Archivo` and
  `JetBrains Mono` load via `@expo-google-fonts/*` (no font files are vendored in `brand/`, so
  Google Fonts packages are the standard Expo path rather than sourcing/hosting `.ttf`s ourselves).

## The data contract

`types/hands-snapshot.d.ts` is generated — **do not edit by hand** — from
`engine/src/snapshot.ts`'s `MobileAgent`/`MobileTask`/`MobileQuestion`/`MobileSnapshot`
interfaces, via `engine/scripts/extract-mobile-types.mjs`. Regenerate after any change to those
interfaces:

```bash
npm run sync-brand   # regenerates types/hands-snapshot.d.ts AND theme/tokens.json
```

**This is deliberately its own narrow view, not the `PublicSnapshot` vendored into
hands-website's `types/hands-dashboard-snapshot.d.ts`.** `PublicSnapshot` is the redacted,
cross-repo-safe shape (see its doc comment in `snapshot.ts`) — it drops live agent presence
entirely, because that's meaningless once the pane that pushed a remote snapshot isn't the pane
you're looking at. This app connects straight to a LAN `hands serve` instance, not a remote
mirror, and "the line" screen's whole point is showing station online/idle state — data
`PublicSnapshot` doesn't carry. `MobileSnapshot` keeps it; there's no privacy boundary to redact
across on a local connection.

Why a generated file instead of importing `engine/src/snapshot.ts` directly, given this app lives
in the same repo: this repo isn't an npm/yarn/pnpm workspace (no root `package.json` — `engine/`
is a fully standalone package), and reaching across with a relative import would pull this app's
TS compilation into engine's module graph (`Store`, `node:sqlite`, other server-only deps) for a
client that needs 4 flat interfaces. A generated, regenerate-on-demand `.d.ts` is the pattern this
repo already trusts for exactly this shape of problem — see `extract-public-types.mjs`.

## Running it

```bash
npm install
npm run ios        # or: npm run android
```

Defaults to `localhost:4319` (`hands serve`'s default port) — works immediately in a simulator on
this machine. **A physical phone cannot reach `localhost`** — that resolves to the phone itself,
not your computer. Open the Settings tab and enter your computer's LAN IP instead (e.g.
`192.168.1.42:4319`); there's no auto-discovery, just a text field that persists via
`@react-native-async-storage/async-storage`.

`npm run web` also works (react-native-web) — used during development to preview without a
simulator. Not a target platform for this ticket; keep it working as a convenience, but the real
surface is iOS/Android via Expo Go.

## Scope (hands#107 — walking skeleton)

- Connect, hold the SSE stream, survive disconnect/reconnect (including backgrounding).
- Rail: tickets grouped by dish.
- Line: stations, what each is working on, alive/idle.
- Needs you: open questions — **read-only**, shown but not answerable. `hands_answer` /
  `hands_escalate` stay a decision made from the dashboard or CLI; this app sends nothing.

Everything past that (a richer per-ticket view, push notifications, answering questions from the
phone) is explicitly the next ticket, not silently expanded scope here.
