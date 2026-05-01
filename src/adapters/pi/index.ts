import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class PiAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "pi",
      clientName: "Pi Coding Agent",
      configPath: ".pi/mcp.json or ~/.pi/agent/mcp.json",
      scope: "project"
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("mcpServers", options);
  }
}
