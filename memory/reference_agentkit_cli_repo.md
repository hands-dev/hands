---
name: agentkit CLI repo
description: GitHub repo for the `and` CLI (separate from ampersand). Houses the CLI binary and Claude Code skill that wraps it.
type: reference
originSessionId: 3c920124-da89-4e83-a899-105b978a801a
---
**Repo**: https://github.com/theandcompany/agentkit

Houses the `and` CLI — a separate repository from the main ampersand monorepo. The CLI is intended to have functional parity with the MCP server (`apps/mcp` in ampersand) but calls the API directly (POST /v1/...) rather than proxying through the MCP server.

**Direction shift (cycle 14)**: previous direction included an openclaw runtime + ngrok tunnel for authentication; that has been abandoned. New direction is API-direct CLI with the mobile controller app as the login plane (same OAuth/QR flow used for Claude/ChatGPT MCP auth — see eng-645).

**Owner**: Santiago drives this work.

**Companion skill**: a Claude Code skill in the ampersand repo at `.claude/skills/and-cli/` that lets Claude invoke `and …` commands (TBD as part of cycle 14).
