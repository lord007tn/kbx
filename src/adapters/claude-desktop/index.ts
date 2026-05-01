import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class ClaudeDesktopAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "claude-desktop",
      clientName: "Claude Desktop",
      configPath: "claude_desktop_config.json",
      scope: "user"
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("mcpServers", options);
  }
}
