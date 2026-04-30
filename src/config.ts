import type { WorkspaceConfig } from "./types.js";

const CONFIG_KEYS = new Set(["chunk.size", "chunk.overlap", "chunk.strategy", "mcp.citations"]);

export function getConfigValue(config: WorkspaceConfig, key: string): unknown {
  assertKnownKey(key);
  const [section, property] = key.split(".");
  return (config as unknown as Record<string, Record<string, unknown>>)[section!]![property!]!;
}

export function setConfigValue(config: WorkspaceConfig, key: string, rawValue: string): WorkspaceConfig {
  assertKnownKey(key);
  const next = structuredClone(config);

  switch (key) {
    case "chunk.size":
      next.chunk.size = parsePositiveInteger(rawValue, key);
      break;
    case "chunk.overlap":
      next.chunk.overlap = parseNonNegativeInteger(rawValue, key);
      if (next.chunk.overlap >= next.chunk.size) {
        throw new Error("chunk.overlap must be smaller than chunk.size");
      }
      break;
    case "chunk.strategy":
      if (rawValue !== "fixed") {
        throw new Error("Only chunk.strategy=fixed is supported right now");
      }
      next.chunk.strategy = rawValue;
      break;
    case "mcp.citations":
      if (rawValue !== "safe" && rawValue !== "full-path") {
        throw new Error("mcp.citations must be safe or full-path");
      }
      next.mcp.citations = rawValue;
      break;
  }

  return next;
}

export function listConfigValues(config: WorkspaceConfig): Array<{ key: string; value: unknown }> {
  return [...CONFIG_KEYS].sort().map((key) => ({
    key,
    value: getConfigValue(config, key)
  }));
}

function assertKnownKey(key: string): void {
  if (!CONFIG_KEYS.has(key)) {
    throw new Error(`Unknown config key "${key}".`);
  }
}

function parsePositiveInteger(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return parsed;
}
