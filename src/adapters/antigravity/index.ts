import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class AntigravityAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "antigravity",
      clientName: "Antigravity",
      configPath: "~/.gemini/antigravity/mcp_config.json",
      scope: "user"
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("mcpServers", options);
  }
}
