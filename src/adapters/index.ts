import { AntigravityAdapter } from "./antigravity";
import { BaseAdapter } from "./base";
import { ClaudeCodeAdapter } from "./claude-code";
import { ClaudeDesktopAdapter } from "./claude-desktop";
import { CodexAdapter } from "./codex";
import { CursorAdapter } from "./cursor";
import { GeminiCLIAdapter } from "./gemini-cli";
import { JetBrainsCopilotAdapter } from "./jetbrains-copilot";
import { KiloAdapter } from "./kilo";
import { KiroAdapter } from "./kiro";
import { OpenCodeAdapter } from "./opencode";
import { PiAdapter } from "./pi";
import { QwenCodeAdapter } from "./qwen-code";
import { VSCodeCopilotAdapter } from "./vscode-copilot";
import { ZedAdapter } from "./zed";
import type { AdapterConfigOptions, AdapterConfigSnippet, AdapterHookSnippet, AdapterId, AdapterValidationResult } from "./types";

export type AdapterAlias =
  | AdapterId
  | "claude"
  | "vscode"
  | "jetbrains"
  | "gemini"
  | "qwen";

const adapters: BaseAdapter[] = [
  new ClaudeDesktopAdapter(),
  new ClaudeCodeAdapter(),
  new CursorAdapter(),
  new CodexAdapter(),
  new GeminiCLIAdapter(),
  new VSCodeCopilotAdapter(),
  new JetBrainsCopilotAdapter(),
  new ZedAdapter(),
  new OpenCodeAdapter(),
  new KiloAdapter(),
  new KiroAdapter(),
  new QwenCodeAdapter(),
  new AntigravityAdapter(),
  new PiAdapter()
];

const aliasToId: Record<string, AdapterId> = {
  claude: "claude-desktop",
  "claude-desktop": "claude-desktop",
  "claude-code": "claude-code",
  cursor: "cursor",
  codex: "codex",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
  vscode: "vscode-copilot",
  "vscode-copilot": "vscode-copilot",
  jetbrains: "jetbrains-copilot",
  "jetbrains-copilot": "jetbrains-copilot",
  zed: "zed",
  opencode: "opencode",
  kilo: "kilo",
  kiro: "kiro",
  qwen: "qwen-code",
  "qwen-code": "qwen-code",
  antigravity: "antigravity",
  pi: "pi"
};

export function listAdapters(): BaseAdapter[] {
  return [...adapters];
}

export function adapterIds(): AdapterId[] {
  return adapters.map((adapter) => adapter.id);
}

export function resolveAdapter(idOrAlias: string): BaseAdapter {
  const id = aliasToId[idOrAlias];
  if (!id) {
    throw new Error(`Unknown MCP client "${idOrAlias}". Known clients: ${adapterIds().join(", ")}`);
  }

  const adapter = adapters.find((candidate) => candidate.id === id);
  if (!adapter) {
    throw new Error(`MCP client "${id}" is registered without an adapter.`);
  }
  return adapter;
}

export function generateAdapterConfig(
  idOrAlias: string,
  options: AdapterConfigOptions = {}
): AdapterConfigSnippet {
  return resolveAdapter(idOrAlias).generateConfig(options);
}

export function generateAllAdapterConfigs(options: AdapterConfigOptions = {}): AdapterConfigSnippet[] {
  return adapters.map((adapter) => adapter.generateConfig(options));
}

export function generateAdapterHooks(
  idOrAlias: string,
  options: AdapterConfigOptions = {}
): AdapterHookSnippet {
  const snippet = resolveAdapter(idOrAlias).generateHooks(options);
  if (!snippet) {
    throw new Error(`MCP client "${idOrAlias}" does not have a kbx hook adapter.`);
  }
  return snippet;
}

export function generateAllAdapterHooks(options: AdapterConfigOptions = {}): AdapterHookSnippet[] {
  return adapters
    .map((adapter) => adapter.generateHooks(options))
    .filter((snippet): snippet is AdapterHookSnippet => snippet !== null);
}

export function validateAdapterConfig(snippet: AdapterConfigSnippet): AdapterValidationResult {
  const base = {
    adapter: snippet.adapter,
    clientName: snippet.clientName,
    configPath: snippet.configPath
  };

  if (!snippet.content.trim()) {
    return { ...base, ok: false, detail: "empty config content" };
  }
  if (snippet.content.includes("undefined")) {
    return { ...base, ok: false, detail: "config content contains undefined" };
  }

  try {
    if (snippet.format === "json" || snippet.format === "jsonc") {
      JSON.parse(snippet.content);
    } else if (!snippet.content.includes("[mcp_servers.")) {
      return { ...base, ok: false, detail: "TOML snippet is missing an mcp_servers table" };
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  if (!/\bkbx\b/.test(snippet.content)) {
    return { ...base, ok: false, detail: "config content does not reference the kbx command" };
  }

  return { ...base, ok: true, detail: "valid" };
}

export function validateAllAdapterConfigs(options: AdapterConfigOptions = {}): AdapterValidationResult[] {
  return generateAllAdapterConfigs(options).map(validateAdapterConfig);
}

export type { AdapterConfigOptions, AdapterConfigSnippet, AdapterHookSnippet, AdapterId, AdapterValidationResult };
