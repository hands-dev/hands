---
name: Cycle 14 plan (May 4–11, 2026)
description: Engineering cycle 14 plan — three streams (CLI, Connections, Privacy) plus Michael's app-store submission. Full plan at .claude/plans/so-our-team-is-lazy-rocket.md.
type: project
originSessionId: 3c920124-da89-4e83-a899-105b978a801a
---
**Plan file**: `.claude/plans/so-our-team-is-lazy-rocket.md` (full detail there).

**Cycle dates**: 2026-05-04 through 2026-05-11 (Linear cycle 14, Engineering team).

**Three streams**:
1. **CLI + skill** (Santiago) — `and` CLI in https://github.com/theandcompany/agentkit, parity with MCP, API-direct, controller-app login plane.
2. **Connections** (Michael) — request/accept flow, search, profile pages, mobile tab, MCP `connections_read` + `andee_read`. Backend partly exists; layer on top.
3. **Privacy settings** (Michael) — per-HDS-node visibility (`private`/`connected`/`public`) with parent-walk inheritance. Default private. New table `andee_node_visibility`. Filter at every cross-andee read path.

**Top priority overlay**: Michael ships ENG-647 (app store submission) before any stream-2/3 work.

**Why**: Connections is the multiplayer differentiator that hasn't shown up in product. Privacy is the gating dependency for cross-andee reads. CLI gives third-party agents the same surface as MCP.

**How to apply**: when working on any of these three streams next 1–2 weeks, reference the plan file for sequencing, file paths, and verification approach. Privacy filter is the gating dependency — build it day 1–2, then connections layers on it. Designs not blocking — engineering starts on schema/backend/MCP and unstyled mobile shells immediately.

**Carry-overs from cycle 13**: ENG-664 (deploy bug, Michael), ENG-643 (MCP directories, Santiago), ENG-639 + ENG-648 (unowned, dropped from scope), ENG-640 (marketing pages, Santiago), ENG-618 (iOS bundle ID, Michael — timing TBD).
