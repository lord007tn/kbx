import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet } from "../types";

export class QwenCodeAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "qwen-code",
      clientName: "Qwen Code",
      configPath: "~/.qwen/settings.json",
      scope: "user"
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("mcpServers", options);
  }
}
