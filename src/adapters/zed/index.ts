import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class ZedAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "zed",
      clientName: "Zed",
      configPath: "~/.config/zed/settings.json",
      scope: "user",
      notes: [
        "Zed uses context_servers and command.path syntax instead of mcpServers."
      ]
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    const { serverName, command, args, env } = this.command(options);
    const commandConfig: Record<string, unknown> = { path: command };
    if (args) {
      commandConfig.args = args;
    }
    if (env) {
      commandConfig.env = env;
    }

    return this.snippet("json", {
      context_servers: {
        [serverName]: {
          command: commandConfig
        }
      }
    });
  }
}
