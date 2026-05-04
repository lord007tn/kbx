import type { UserConfig, WorkspaceConfig } from "./types";

const CONFIG_KEYS = new Set(["chunk.size", "chunk.overlap", "chunk.strategy", "mcp.citations", "mcp.destructive_tools"]);
const USER_CONFIG_KEYS = new Set(["init.root_preference"]);

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
      if (next.chunk.overlap >= next.chunk.size) {
        throw new Error("chunk.size must be larger than chunk.overlap");
      }
      break;
    case "chunk.overlap":
      next.chunk.overlap = parseNonNegativeInteger(rawValue, key);
      if (next.chunk.overlap >= next.chunk.size) {
        throw new Error("chunk.overlap must be smaller than chunk.size");
      }
      break;
    case "chunk.strategy":
      if (rawValue !== "heading" && rawValue !== "fixed" && rawValue !== "sentence") {
        throw new Error("chunk.strategy must be heading, fixed, or sentence");
      }
      next.chunk.strategy = rawValue;
      break;
    case "mcp.citations":
      if (rawValue !== "safe" && rawValue !== "full-path") {
        throw new Error("mcp.citations must be safe or full-path");
      }
      next.mcp.citations = rawValue;
      break;
    case "mcp.destructive_tools":
      if (rawValue !== "disabled" && rawValue !== "enabled") {
        throw new Error("mcp.destructive_tools must be disabled or enabled");
      }
      next.mcp.destructive_tools = rawValue;
      break;
  }

  return next;
}

export function getUserConfigValue(config: UserConfig, key: string): unknown {
  assertKnownUserKey(key);
  const [section, property] = key.split(".");
  return (config as unknown as Record<string, Record<string, unknown>>)[section!]![property!]!;
}

export function setUserConfigValue(config: UserConfig, key: string, rawValue: string): UserConfig {
  assertKnownUserKey(key);
  const next = structuredClone(config);

  switch (key) {
    case "init.root_preference":
      if (rawValue !== "current" && rawValue !== "git-root") {
        throw new Error("init.root_preference must be current or git-root");
      }
      next.init.root_preference = rawValue;
      break;
  }

  return next;
}

export function listUserConfigValues(config: UserConfig): Array<{ key: string; value: unknown }> {
  return [...USER_CONFIG_KEYS].sort().map((key) => ({
    key,
    value: getUserConfigValue(config, key)
  }));
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

function assertKnownUserKey(key: string): void {
  if (!USER_CONFIG_KEYS.has(key)) {
    throw new Error(`Unknown user config key "${key}".`);
  }
}

function parsePositiveInteger(value: string, key: string): number {
  const parsed = parseIntegerLiteral(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, key: string): number {
  const parsed = parseIntegerLiteral(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return parsed;
}

function parseIntegerLiteral(value: string): number {
  const trimmed = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) {
    return Number.NaN;
  }
  return Number(trimmed);
}
