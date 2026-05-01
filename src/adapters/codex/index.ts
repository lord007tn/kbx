import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class CodexAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "codex",
      clientName: "Codex CLI",
      configPath: "~/.codex/config.toml",
      scope: "user"
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    const { serverName, command, args, env } = this.command(options);
    const lines = [
      `[mcp_servers.${serverName}]`,
      `command = ${this.tomlString(command)}`
    ];

    if (args) {
      lines.push(`args = [${args.map((arg) => this.tomlString(arg)).join(", ")}]`);
    }

    if (env && Object.keys(env).length > 0) {
      lines.push("", `[mcp_servers.${serverName}.env]`);
      for (const [key, value] of Object.entries(env)) {
        lines.push(`${key} = ${this.tomlString(value)}`);
      }
    }

    return this.snippet("toml", `${lines.join("\n")}\n`);
  }
}
