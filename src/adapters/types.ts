export type AdapterId =
  | "claude-desktop"
  | "claude-code"
  | "cursor"
  | "codex"
  | "gemini-cli"
  | "vscode-copilot"
  | "jetbrains-copilot"
  | "zed"
  | "opencode"
  | "kilo"
  | "kiro"
  | "qwen-code"
  | "antigravity"
  | "pi";

export type AdapterConfigFormat = "json" | "jsonc" | "toml";

export type AdapterConfigScope = "project" | "user" | "ide";

export interface AdapterConfigOptions {
  serverName?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AdapterConfigSnippet {
  adapter: AdapterId;
  clientName: string;
  configPath: string;
  format: AdapterConfigFormat;
  scope: AdapterConfigScope;
  content: string;
  notes: string[];
}

export interface AdapterHookSnippet {
  adapter: AdapterId;
  clientName: string;
  configPath: string;
  format: AdapterConfigFormat;
  scope: AdapterConfigScope;
  content: string;
  notes: string[];
}

export interface AdapterValidationResult {
  adapter: AdapterId;
  clientName: string;
  configPath: string;
  ok: boolean;
  detail: string;
}
