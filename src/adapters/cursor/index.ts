import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class CursorAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "cursor",
      clientName: "Cursor",
      configPath: ".cursor/mcp.json or ~/.cursor/mcp.json",
      scope: "project"
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("mcpServers", options);
  }
}
