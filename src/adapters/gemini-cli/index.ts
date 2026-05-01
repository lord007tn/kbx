import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class GeminiCLIAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "gemini-cli",
      clientName: "Gemini CLI",
      configPath: "~/.gemini/settings.json",
      scope: "user"
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("mcpServers", options);
  }
}
