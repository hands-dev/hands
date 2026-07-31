---
name: project_runtime_web_rag_capability
description: Andee OpenClaw runtimes CAN do web RAG from a URL under the messaging tools profile (verified on staging) — enables URL-only extension agent chat
metadata: 
  node_type: memory
  type: project
  originSessionId: b58ab94a-11ea-4500-af67-d30cb5a49b1f
---

Verified 2026-07-24 on staging runtime `openclaw-rt-staging-michael-phillipszz-351b3cf3` (project `and-dev-89990`): the andee's own OpenClaw agent (`main`, model `openai/gpt-5.4-mini`, `tools.profile: "messaging"`) **can fetch arbitrary URLs and ground on their live content** — no browser plugin / Chromium needed.

**Evidence (behavioral probes via `openclaw agent`):**
- example.com → returned real `<title>` "Example Domain" (tool `web_search`, 1 call, 0 failures).
- `https://httpbin.org/uuid` → returned the actual per-request random UUID `94ae963e-…` — impossible from training/snippets, so it's a **genuine live fetch**, not topic search.
- Specific YouTube watch URL (`?v=dQw4w9WgXcQ`) → returned exact title + channel ("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)" — Rick Astley), 2 calls, 0 failures. So it grounds on specific JS-heavy SPA URLs too (YouTube server-renders og/meta tags).

**Config facts (`/var/lib/ampersand-runtime/.openclaw/openclaw.json`):**
- `plugins.allow` includes `browser` (+ canvas, device-pair, file-transfer, memory-core, phone-control, talk-voice), but there is **NO Chromium/Chrome binary on the VM** (only apparmor stubs) and no Playwright cache — the `browser` plugin is NOT the RAG path. The web tool (`web_search` + fetch) under the messaging profile is.
- `tools.profile: "messaging"` does NOT strip the web tool. (The `MESSAGING_TOOLS`/`isMessagingTool` set in the engine — `sessions_send`, `message` — is a send-action classifier, NOT the profile filter; don't confuse them.)

**Design implication:** the "send just the URL, let the agent do its own RAG" model for extension agent chat is viable — no client-side page extractor, no schema, no excerpt caps. Extension attaches the current tab's (cleaned) URL to `CHAT_SEND`; backend `/v1/developer/agent/messages` passes an optional `url` through to the runtime. Caveat: the agent's fetch is anonymous (not logged in as the andee), so authed/paywalled pages give the public view only.

**How to run a probe:** IAP-SSH to the VM, then `sudo -u and-runtime -H bash -lc "cd /var/lib/ampersand-runtime && set -a && . /etc/ampersand-runtime/runtime.env && set +a && openclaw agent --agent main --session-key <key> --json -m '<prompt>'"`. `runtime.env` holds `OPENCLAW_GATEWAY_TOKEN` (readable by group `and-runtime`, uid 999). Omit `--deliver` so no message hits the real device.

Related: [[reference_staging_gcp_access]], [[project_fleet_skills_publish_71a7517b]].
