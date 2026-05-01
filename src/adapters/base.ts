import type { AdapterConfigOptions, AdapterConfigScope, AdapterConfigSnippet, AdapterHookSnippet, AdapterId } from "./types";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CommandDefaults {
  command: string;
  args?: string[];
}

export interface BaseAdapterOptions {
  id: AdapterId;
  clientName: string;
  configPath: string;
  scope: AdapterConfigScope;
  defaults?: CommandDefaults;
  notes?: string[];
}

export abstract class BaseAdapter {
  readonly id: AdapterId;
  readonly clientName: string;
  readonly configPath: string;
  readonly scope: AdapterConfigScope;
  protected readonly defaults: CommandDefaults;
  protected readonly notes: string[];

  constructor(options: BaseAdapterOptions) {
    this.id = options.id;
    this.clientName = options.clientName;
    this.configPath = options.configPath;
    this.scope = options.scope;
    this.defaults = options.defaults ?? { command: "kbx", args: ["mcp"] };
    this.notes = options.notes ?? [];
  }

  abstract generateConfig(options?: AdapterConfigOptions): AdapterConfigSnippet;

  generateHooks(_options: AdapterConfigOptions = {}): AdapterHookSnippet | null {
    return null;
  }

  protected command(options: AdapterConfigOptions = {}): {
    serverName: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  } {
    const args = options.args ?? this.defaults.args;
    const env = options.env && Object.keys(options.env).length > 0 ? options.env : undefined;
    return {
      serverName: options.serverName ?? "kbx",
      command: options.command ?? this.defaults.command,
      args: args && args.length > 0 ? args : undefined,
      env
    };
  }

  protected jsonConfig(
    rootKey: "mcpServers" | "servers",
    options: AdapterConfigOptions = {}
  ): AdapterConfigSnippet {
    const { serverName, command, args, env } = this.command(options);
    const server: Record<string, JsonValue> = { command };
    if (args) {
      server.args = args;
    }
    if (env) {
      server.env = env;
    }

    return this.snippet("json", {
      [rootKey]: {
        [serverName]: server
      }
    });
  }

  protected snippet(format: AdapterConfigSnippet["format"], content: unknown): AdapterConfigSnippet {
    return {
      adapter: this.id,
      clientName: this.clientName,
      configPath: this.configPath,
      format,
      scope: this.scope,
      content: typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      notes: this.notes
    };
  }

  protected hookSnippet(format: AdapterHookSnippet["format"], content: unknown, notes = this.notes): AdapterHookSnippet {
    return {
      adapter: this.id,
      clientName: this.clientName,
      configPath: this.configPath,
      format,
      scope: this.scope,
      content: typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      notes
    };
  }

  protected tomlString(value: string): string {
    return JSON.stringify(value);
  }
}
