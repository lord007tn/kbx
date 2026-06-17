import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class JetBrainsCopilotAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "jetbrains-copilot",
      clientName: "JetBrains Copilot",
      configPath: "Settings > Tools > GitHub Copilot > MCP",
      scope: "ide",
      defaults: { command: "npx", args: ["-y", "@lord007tn/kbx", "mcp"] },
      notes: [
        "JetBrains stores MCP registration in IDE settings; paste this server entry through the MCP settings UI."
      ]
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("servers", options);
  }
}
