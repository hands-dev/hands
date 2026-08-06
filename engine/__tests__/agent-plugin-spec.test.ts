import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * plugin/plugin.json and plugin/mcp.json are a second, portable manifest
 * pair — conforming to the Agent Plugins open standard (agent-plugins.org
 * v1.0.0) — that sits alongside Claude Code's own .claude-plugin/plugin.json
 * and .mcp.json (hands#136). Nothing here talks to the network: the spec
 * itself forbids clients from fetching the schema at load time, and there's
 * no reason for this guard to depend on network access either. This just
 * pins the two files' shape so a future edit can't silently drift out of the
 * closed schemas.
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin");

const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

describe("plugin/plugin.json (Agent Plugins manifest)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8"));

  const closedFields = [
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ];

  it("declares the canonical schema identifier", () => {
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  });

  it("has a name satisfying the spec's naming pattern", () => {
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThanOrEqual(1);
    expect(manifest.name.length).toBeLessThanOrEqual(64);
    expect(manifest.name).toMatch(NAME_PATTERN);
  });

  it("contains only fields from the closed schema", () => {
    for (const key of Object.keys(manifest)) {
      expect(closedFields).toContain(key);
    }
  });
});

describe("plugin/mcp.json (Agent Plugins MCP configuration)", () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, "mcp.json"), "utf8"));

  it("declares the canonical schema identifier", () => {
    expect(config.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  });

  it("contains only $schema and mcpServers at the top level", () => {
    expect(Object.keys(config).sort()).toEqual(["$schema", "mcpServers"]);
  });

  it("gives every server entry a valid transport type", () => {
    const servers = config.mcpServers as Record<string, { type: string }>;
    expect(Object.keys(servers).length).toBeGreaterThan(0);
    for (const server of Object.values(servers)) {
      expect(["stdio", "streamable-http", "sse"]).toContain(server.type);
    }
  });

  it("the hands stdio server has a single-token command and a string-array args", () => {
    const hands = config.mcpServers.hands;
    expect(hands.type).toBe("stdio");
    expect(typeof hands.command).toBe("string");
    expect(hands.command.length).toBeGreaterThan(0);
    expect(hands.command).not.toMatch(/\s/);
    expect(Array.isArray(hands.args)).toBe(true);
    for (const arg of hands.args) {
      expect(typeof arg).toBe("string");
    }
  });
});
