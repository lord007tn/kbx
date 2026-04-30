import assert from "node:assert/strict";
import test from "node:test";
import { getConfigValue, setConfigValue } from "../src/config";
import { defaultConfig } from "../src/workspace";

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
