---
name: install-cli
description: Installs the standalone hands CLI into ~/.hands (lib + bin) by running the official installer (hands-cc.dev/install.sh), so `hands` works in a normal terminal outside Claude Code — not just on the plugin's own Bash-tool PATH. Optional; the plugin already puts `hands` on Claude Code's own Bash PATH without this. Use when the principal says /hands:install-cli, "put hands on my PATH", "install the hands CLI", "can I use hands in a regular terminal", or asks how to get `hands` working outside Claude Code.
---

# Install CLI — put `hands` on a real terminal's PATH

The plugin already puts `hands` on Claude Code's own internal Bash-tool PATH — every skill and
every Bash call in this session already has it. This skill is for the *separate* case: the
principal wants to run `hands` from a normal terminal window they open themselves, outside Claude
Code entirely (e.g. `hands ampersand station-2` from iTerm). That needs the standalone installer,
because a plain shell never sees the plugin's own directory.

## Steps

1. **Set expectations before running it** — say plainly: *"I'll run the official installer
   (`curl -fsSL https://hands-cc.dev/install.sh | sh`). It downloads `hands` into `~/.hands/lib`
   and `~/.hands/bin`, chmods it executable, and prints whether `~/.hands/bin` is already on your
   PATH. It never edits your shell rc files — if it's not on PATH yet, it prints the exact
   `export PATH=...` line for you to add yourself."*
2. **Run it** (Bash): `curl -fsSL https://hands-cc.dev/install.sh | sh`. It's idempotent — safe to
   re-run anytime to pick up a newer version.
3. **Relay its output verbatim** — it already prints the version installed and either "Run: hands
   doctor" (already on PATH) or the exact `export PATH="$HOME/.hands/bin:$PATH"` line to add. Don't
   paraphrase the PATH line; the principal needs the literal text to paste.
4. **If PATH needs updating**, don't edit their shell rc file yourself — tell them the line to add
   and which file it typically goes in for their shell (`~/.zshrc` for zsh, the macOS default;
   `~/.bashrc` or `~/.bash_profile` for bash), and that they'll need to open a new terminal (or
   `source` that file) afterward.
5. **Mention it's optional and re-runnable.** The plugin's own Bash-tool PATH is untouched either
   way — this only affects terminals opened outside Claude Code. `hands version` reports which
   build (plugin vs. standalone) is running wherever `hands` is called from, and flags it when the
   two disagree.

## Guardrails

- Never edit `.zshrc`/`.bashrc`/`.bash_profile` or any other shell rc file — the installer itself
  deliberately never does this (`install.sh`'s own comment: "never edit the user's shell rc
  uninvited"), and this skill inherits that rule.
- This installs local files under `~/.hands` only — no sudo, no system-wide changes, nothing
  outside the principal's home directory.
- If `node -v` is below 22.5 or `node` isn't found, the installer will fail with a clear
  `hands: node >= 22.5 is required...` message — relay that verbatim rather than guessing at a fix.
