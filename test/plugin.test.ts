import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Claude Code marketplace points at the packaged kbx plugin", async () => {
  const marketplace = JSON.parse(await readFile(path.join(".claude-plugin", "marketplace.json"), "utf8")) as {
    name: string;
    plugins: Array<{ name: string; source: string }>;
  };

  assert.equal(marketplace.name, "kbx-tools");
  assert.deepEqual(marketplace.plugins.map((plugin) => ({
    name: plugin.name,
    source: plugin.source
  })), [{
    name: "kbx",
    source: "./plugins/claude-code/kbx"
  }]);
});

test("Claude Code plugin exposes MCP, hooks, command, and skill", async () => {
  const pluginRoot = path.join("plugins", "claude-code", "kbx");
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")) as {
    name: string;
    version: string;
    mcpServers?: string;
    hooks?: string;
  };
  const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8")) as {
    mcpServers: { kbx: { command: string; args: string[] } };
  };
  const hooks = JSON.parse(await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8")) as {
    hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
  };
  const skill = await readFile(path.join(pluginRoot, "skills", "kbx-dev-mode", "SKILL.md"), "utf8");
  const command = await readFile(path.join(pluginRoot, "commands", "kbx-status.md"), "utf8");

  assert.equal(manifest.name, "kbx");
  assert.equal(manifest.version, "0.1.2");
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.hooks, undefined);
  assert.deepEqual(mcp.mcpServers.kbx, {
    command: "npx",
    args: ["-y", "@lord007tn/kbx", "mcp"]
  });
  assert.equal(hooks.hooks.PostToolUse[0]!.matcher, "Write|Edit|MultiEdit");
  assert.equal(hooks.hooks.PostToolUse[0]!.hooks[0]!.command, "npx -y @lord007tn/kbx hook claude-code post-tool-use");
  assert.match(skill, /kbx_dev_report_add/);
  assert.match(command, /kbx workspace freshness/);
});
