#!/usr/bin/env sh
# hands — standalone installer.
#
#   curl -fsSL https://hands-cc.dev/install.sh | sh
#
# Installs the `hands` CLI into ~/.hands (lib + bin) with no npm step: the
# bundles are committed in the repo, so this is a download and a chmod.
#
# Why standalone at all, when the Claude Code plugin already puts `hands` on
# PATH? Because the plugin's copy only moves when you remember to update the
# plugin, and a stale copy is invisible: the symptom is "that command doesn't
# exist" while your checkout plainly has it. A standalone install is one you
# control, and `hands version` / `hands doctor` will tell you when the two
# disagree.
#
# POSIX sh on purpose — this runs before anything of ours exists.

set -eu

REPO="${HANDS_REPO:-hands-dev/hands}"
REF="${HANDS_REF:-main}"
PREFIX="${HANDS_PREFIX:-$HOME/.hands}"
# HANDS_BASE overrides where the payload comes from — an internal mirror, or a
# local checkout (file:///path/to/hands/plugin/dist) when testing the installer
# itself. Defaults to the public repo at the pinned ref.
BASE="${HANDS_BASE:-https://raw.githubusercontent.com/${REPO}/${REF}/plugin/dist}"

LIB="$PREFIX/lib"
BIN="$PREFIX/bin"

say() { printf '%s\n' "$*"; }
die() { printf 'hands: %s\n' "$*" >&2; exit 1; }

# ── preflight ───────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node is required (>= 22.5) and was not found on PATH"

node_ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a>22||(a===22&&b>=5)?"y":"n")' 2>/dev/null || printf 'n')
[ "$node_ok" = "y" ] || die "node >= 22.5 is required (node:sqlite); found $(node -v 2>/dev/null || echo none)"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "need curl or wget to download"
fi

# ── download to a temp dir, move into place only once everything arrived ────
# A half-written CLI on PATH is worse than no CLI: it fails in ways that look
# like bugs in hands rather than a truncated download.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/hands-install.XXXXXX") || die "could not create a temp dir"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading hands from ${REPO}@${REF}…"
for f in cli.mjs cli-impl.mjs BUILD.json; do
  fetch "$BASE/$f" "$tmp/$f" || die "download failed: $BASE/$f"
  [ -s "$tmp/$f" ] || die "downloaded an empty file: $f"
done

# Sanity-check the payload actually parses before we put it on PATH.
node --input-type=module -e "await import('file://$tmp/cli-impl.mjs')" >/dev/null 2>&1 \
  || say "  (note: could not pre-verify the bundle; continuing)"

mkdir -p "$LIB" "$BIN"
for f in cli.mjs cli-impl.mjs BUILD.json; do
  mv -f "$tmp/$f" "$LIB/$f"
done

cat > "$BIN/hands" <<EOF
#!/usr/bin/env bash
# hands — standalone CLI shim (installed by hands-cc.dev/install.sh)
set -euo pipefail
exec node --no-warnings "$LIB/cli.mjs" "\$@"
EOF
chmod +x "$BIN/hands"

version=$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||"?")}catch(e){process.stdout.write("?")}' "$LIB/BUILD.json" 2>/dev/null || printf '?')
say "✔ hands ${version} installed → ${BIN}/hands"

# ── PATH advice (never edit the user's shell rc uninvited) ──────────────────
case ":${PATH}:" in
  *":$BIN:"*)
    say ""
    say "Run: hands doctor"
    ;;
  *)
    say ""
    say "Add it to your PATH:"
    say ""
    say "  export PATH=\"$BIN:\$PATH\""
    say ""
    say "…then: hands doctor"
    ;;
esac
