import assert from "node:assert/strict";
import test from "node:test";
import { getConfigValue, getUserConfigValue, setConfigValue, setUserConfigValue } from "../src/config";
import { defaultConfig, defaultUserConfig } from "../src/workspace";

test("config get and set handles known keys", () => {
  const config = setConfigValue(defaultConfig, "chunk.size", "1200");
  assert.equal(getConfigValue(config, "chunk.size"), 1200);
});

test("config rejects invalid overlap", () => {
  assert.throws(() => setConfigValue(defaultConfig, "chunk.overlap", "800"), /smaller/);
});

test("config rejects unknown keys", () => {
  assert.throws(() => getConfigValue(defaultConfig, "unknown.key"), /Unknown config key/);
});

test("config accepts sentence chunking", () => {
  const config = setConfigValue(defaultConfig, "chunk.strategy", "sentence");
  assert.equal(getConfigValue(config, "chunk.strategy"), "sentence");
});

test("config gates destructive MCP tools", () => {
  const config = setConfigValue(defaultConfig, "mcp.destructive_tools", "enabled");
  assert.equal(getConfigValue(config, "mcp.destructive_tools"), "enabled");
  assert.throws(() => setConfigValue(defaultConfig, "mcp.destructive_tools", "yes"), /disabled or enabled/);
});

test("user config stores init root preference", () => {
  const config = setUserConfigValue(defaultUserConfig, "init.root_preference", "git-root");
  assert.equal(getUserConfigValue(config, "init.root_preference"), "git-root");
});
