import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class KiroAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "kiro",
      clientName: "Kiro",
      configPath: ".kiro/settings/mcp.json or ~/.kiro/settings/mcp.json",
      scope: "project"
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("mcpServers", options);
  }
}
