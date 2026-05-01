import assert from "node:assert/strict";
import test from "node:test";
import { generateAdapterConfig, generateAdapterHooks, generateAllAdapterConfigs, generateAllAdapterHooks, listAdapters, resolveAdapter, validateAdapterConfig, validateAllAdapterConfigs } from "../src/adapters";
import type { AdapterConfigSnippet } from "../src/adapters";
import { BaseAdapter } from "../src/adapters/base";

test("all MCP adapters inherit from BaseAdapter", () => {
  for (const adapter of listAdapters()) {
    assert.ok(adapter instanceof BaseAdapter, `${adapter.id} should inherit from BaseAdapter`);
  }
});

test("adapter registry lists expected clients", () => {
  const ids = listAdapters().map((adapter) => adapter.id);

  assert.ok(ids.includes("claude-desktop"));
  assert.ok(ids.includes("claude-code"));
  assert.ok(ids.includes("cursor"));
  assert.ok(ids.includes("codex"));
  assert.ok(ids.includes("gemini-cli"));
  assert.ok(ids.includes("vscode-copilot"));
  assert.ok(ids.includes("jetbrains-copilot"));
  assert.ok(ids.includes("zed"));
  assert.ok(ids.includes("opencode"));
  assert.ok(ids.includes("kilo"));
  assert.ok(ids.includes("kiro"));
  assert.ok(ids.includes("qwen-code"));
  assert.ok(ids.includes("antigravity"));
  assert.ok(ids.includes("pi"));
});

test("Claude and Cursor use mcpServers JSON", () => {
  const claude = JSON.parse(generateAdapterConfig("claude").content);
  const cursor = JSON.parse(generateAdapterConfig("cursor").content);

  assert.deepEqual(claude.mcpServers.kbx, {
    command: "kbx",
    args: ["mcp"]
  });
  assert.deepEqual(cursor.mcpServers.kbx, {
    command: "kbx",
    args: ["mcp"]
  });
});

test("Codex uses TOML mcp_servers syntax", () => {
  const snippet = generateAdapterConfig("codex");

  assert.equal(snippet.format, "toml");
  assert.match(snippet.content, /\[mcp_servers\.kbx\]/);
  assert.match(snippet.content, /command = "kbx"/);
  assert.match(snippet.content, /args = \["mcp"\]/);
});

test("Zed uses context_servers command path syntax", () => {
  const parsed = JSON.parse(generateAdapterConfig("zed").content);

  assert.deepEqual(parsed.context_servers.kbx.command, {
    path: "kbx",
    args: ["mcp"]
  });
});

test("OpenCode-style adapters use mcp object without hooks or plugin entries", () => {
  const opencode = JSON.parse(generateAdapterConfig("opencode").content);
  const kilo = JSON.parse(generateAdapterConfig("kilo").content);

  assert.deepEqual(opencode.mcp.kbx, {
    type: "local",
    command: ["kbx", "mcp"]
  });
  assert.equal(opencode.plugin, undefined);
  assert.deepEqual(kilo.mcp.kbx, {
    type: "local",
    command: ["kbx", "mcp"]
  });
  assert.equal(kilo.plugin, undefined);
});

test("VS Code and JetBrains use servers JSON with npx defaults", () => {
  const vscode = JSON.parse(generateAdapterConfig("vscode").content);
  const jetbrains = JSON.parse(generateAdapterConfig("jetbrains").content);

  assert.deepEqual(vscode.servers.kbx, {
    command: "npx",
    args: ["-y", "kbx", "mcp"]
  });
  assert.deepEqual(jetbrains.servers.kbx, {
    command: "npx",
    args: ["-y", "kbx", "mcp"]
  });
});

test("custom command options override adapter defaults", () => {
  const parsed = JSON.parse(generateAdapterConfig("gemini", {
    serverName: "notes",
    command: "node",
    args: ["/opt/kbx/dist/cli.mjs", "mcp"]
  }).content);

  assert.deepEqual(parsed.mcpServers.notes, {
    command: "node",
    args: ["/opt/kbx/dist/cli.mjs", "mcp"]
  });
});

test("Claude Code hook adapter generates a PostToolUse refresh hook", () => {
  const snippet = generateAdapterHooks("claude-code");
  const parsed = JSON.parse(snippet.content);

  assert.equal(snippet.configPath, ".claude/settings.json");
  assert.equal(parsed.hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit");
  assert.equal(parsed.hooks.PostToolUse[0].hooks[0].type, "command");
  assert.equal(parsed.hooks.PostToolUse[0].hooks[0].command, "kbx hook claude-code post-tool-use");
  assert.equal(parsed.hooks.PostToolUse[0].hooks[0].async, true);
});

test("only hook-capable adapters emit hook snippets", () => {
  const snippets = generateAllAdapterHooks();

  assert.deepEqual(snippets.map((snippet) => snippet.adapter), ["claude-code"]);
  assert.throws(() => generateAdapterHooks("codex"), /does not have a kbx hook adapter/);
});

test("unknown adapter aliases are rejected", () => {
  assert.throws(() => resolveAdapter("unknown-client"), /Unknown MCP client/);
});

test("all adapters can generate config snippets", () => {
  const snippets = generateAllAdapterConfigs();

  assert.equal(snippets.length, listAdapters().length);
  assert.ok(snippets.every((snippet) => snippet.content.includes("kbx")));
});

test("all generated adapter configs validate", () => {
  const results = validateAllAdapterConfigs();

  assert.equal(results.length, listAdapters().length);
  assert.deepEqual(results.filter((result) => !result.ok), []);
});

test("adapter validation rejects malformed config content", () => {
  const snippet: AdapterConfigSnippet = {
    ...generateAdapterConfig("cursor"),
    content: "{ broken"
  };

  const result = validateAdapterConfig(snippet);

  assert.equal(result.ok, false);
  assert.match(result.detail, /JSON|position|property|expected/i);
});
