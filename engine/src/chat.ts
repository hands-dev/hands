import { pathToFileURL } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveAgentSdkEntry, resolveHandsServerEntry } from "./mcp-install.js";

/**
 * The dashboard chat is a read-only viewer of kitchen state, not a
 * participant — same invariant the dashboard already holds for the SSE
 * board (it never registers on the bus). This is the hard boundary: no
 * built-in tools (Read/Bash/Edit/...) are ever listed, and only these eight
 * informational hands_* tools are allowed — nothing that sends messages,
 * delegates tickets, or changes state.
 */
export const READ_ONLY_TOOLS = [
  "mcp__hands__hands_board",
  "mcp__hands__hands_tasks",
  "mcp__hands__hands_peers",
  "mcp__hands__hands_history",
  "mcp__hands__hands_menu",
  "mcp__hands__hands_questions",
  "mcp__hands__hands_paths",
  "mcp__hands__hands_todos",
] as const;

const SYSTEM_PROMPT =
  "You are the read-only assistant embedded in the hands dashboard. Answer questions about " +
  "the kitchen's current work using only the hands_* tools available to you. You cannot send " +
  "messages, delegate tickets, or change anything — if asked to take an action, say so plainly " +
  "and explain that you're read-only.";

export type ChatEvent =
  | { type: "tool"; name: string }
  | { type: "text"; text: string }
  | { type: "done"; sessionId: string; error?: string }
  | { type: "unavailable" };

type AgentSdkModule = {
  query(params: { prompt: string; options?: Options }): AsyncGenerator<SDKMessage, void>;
};

/**
 * Cheap, synchronous availability check for the dashboard payload's
 * `chatAvailable` flag — existence checks only, no module load. The Agent
 * SDK is a dev-checkout-only dependency (see resolveAgentSdkEntry); a
 * plugin-cache install has neither it nor a reason to pay for probing it on
 * every SSE tick.
 */
export function hasAgentSdkInstalled(): boolean {
  return resolveAgentSdkEntry() !== null && resolveHandsServerEntry() !== null;
}

async function loadAgentSdk(): Promise<AgentSdkModule | null> {
  const entry = resolveAgentSdkEntry();
  if (!entry) return null;
  try {
    return (await import(pathToFileURL(entry).href)) as AgentSdkModule;
  } catch {
    return null;
  }
}

/**
 * Run one chat turn against the local hands MCP server (spawned fresh per
 * turn, same bundled entry Claude Code itself launches). `cwd` should be the
 * same directory the caller's own Store/dbPath resolution already uses —
 * the MCP subprocess has no separate coordination-dir override, it inherits
 * cwd from the session, so this is what makes it open the same database.
 */
export async function* runChatTurn(params: {
  prompt: string;
  resume?: string;
  cwd: string;
}): AsyncGenerator<ChatEvent> {
  const sdk = await loadAgentSdk();
  const handsServerEntry = resolveHandsServerEntry();
  if (!sdk || !handsServerEntry) {
    yield { type: "unavailable" };
    return;
  }

  const options: Options = {
    cwd: params.cwd,
    resume: params.resume,
    systemPrompt: SYSTEM_PROMPT,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: [...READ_ONLY_TOOLS],
    mcpServers: {
      hands: {
        type: "stdio",
        command: "node",
        args: ["--no-warnings", handsServerEntry],
      },
    },
  };

  for await (const message of sdk.query({ prompt: params.prompt, options })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          yield { type: "text", text: block.text };
        } else if (block.type === "tool_use") {
          yield { type: "tool", name: block.name };
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        yield { type: "done", sessionId: message.session_id };
      } else {
        yield {
          type: "done",
          sessionId: message.session_id,
          error: message.errors.join("; ") || message.subtype,
        };
      }
      return;
    }
  }
}
