import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class VSCodeCopilotAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "vscode-copilot",
      clientName: "VS Code Copilot",
      configPath: ".vscode/mcp.json",
      scope: "project",
      defaults: { command: "npx", args: ["-y", "kbx", "mcp"] }
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("servers", options);
  }
}
