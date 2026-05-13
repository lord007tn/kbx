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

test("config rejects chunk sizes that are not larger than overlap", () => {
  assert.throws(() => setConfigValue(defaultConfig, "chunk.size", "50"), /larger than chunk\.overlap/);
});

test("config rejects numeric values with trailing junk", () => {
  assert.throws(() => setConfigValue(defaultConfig, "chunk.size", "1200abc"), /positive integer/);
  assert.throws(() => setConfigValue(defaultConfig, "chunk.overlap", "20px"), /non-negative integer/);
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

test("config controls session capture and graph knowledge", () => {
  const captureConfig = setConfigValue(defaultConfig, "sessions.capture", "full");
  const graphConfig = setConfigValue(captureConfig, "graph.enabled", "enabled");
  const maxChunksConfig = setConfigValue(graphConfig, "graph.max_chunks", "42");

  assert.equal(getConfigValue(maxChunksConfig, "sessions.capture"), "full");
  assert.equal(getConfigValue(maxChunksConfig, "graph.enabled"), "enabled");
  assert.equal(getConfigValue(maxChunksConfig, "graph.max_chunks"), 42);
  assert.throws(() => setConfigValue(defaultConfig, "sessions.capture", "yes"), /disabled, metadata, or full/);
  assert.throws(() => setConfigValue(defaultConfig, "sessions.max_event_bytes", "0"), /positive integer/);
});

test("config controls background watch auto-start", () => {
  const config = setConfigValue(defaultConfig, "watch.auto", "enabled");
  assert.equal(getConfigValue(config, "watch.auto"), "enabled");
  assert.throws(() => setConfigValue(defaultConfig, "watch.auto", "yes"), /disabled or enabled/);
});

test("config controls opt-in dev reports", () => {
  const config = setConfigValue(defaultConfig, "dev.report", "enabled");
  assert.equal(getConfigValue(config, "dev.report"), "enabled");
  assert.throws(() => setConfigValue(defaultConfig, "dev.report", "yes"), /disabled or enabled/);
});

test("user config stores init root preference", () => {
  const config = setUserConfigValue(defaultUserConfig, "init.root_preference", "git-root");
  assert.equal(getUserConfigValue(config, "init.root_preference"), "git-root");
});
