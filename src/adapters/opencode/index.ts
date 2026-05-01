import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class OpenCodeAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "opencode",
      clientName: "OpenCode",
      configPath: "opencode.json or ~/.config/opencode/opencode.json",
      scope: "project",
      notes: [
        "This registers the read-only kbx MCP server only. It does not install hooks or enforcement."
      ]
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    const { serverName, command, args, env } = this.command(options);
    const server: Record<string, unknown> = {
      type: "local",
      command: [command, ...(args ?? [])]
    };
    if (env) {
      server.env = env;
    }

    return this.snippet("json", {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [serverName]: server
      }
    });
  }
}
