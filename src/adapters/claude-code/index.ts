import { BaseAdapter } from "../base";
import type { AdapterConfigOptions, AdapterConfigSnippet, AdapterHookSnippet } from "../types";

export class ClaudeCodeAdapter extends BaseAdapter {
  constructor() {
    super({
      id: "claude-code",
      clientName: "Claude Code",
      configPath: ".mcp.json",
      scope: "project",
      notes: [
        "This is MCP-only configuration for kbx. It does not add Claude Code hooks or slash commands."
      ]
    });
  }

  generateConfig(options: AdapterConfigOptions = {}): AdapterConfigSnippet {
    return this.jsonConfig("mcpServers", options);
  }

  generateHooks(options: AdapterConfigOptions = {}): AdapterHookSnippet {
    const { command } = this.command(options);
    return {
      ...this.hookSnippet("json", {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit|MultiEdit",
            hooks: [
              {
                type: "command",
                command: `${command} hook claude-code post-tool-use`,
                async: true,
                timeout: 120
              }
            ]
          }
        ]
      }
      }, [
        "Merge this with any existing .claude/settings.json hooks; do not overwrite unrelated hooks.",
        "The hook refreshes kbx for edited workspace files after Claude Code Write/Edit/MultiEdit succeeds."
      ]),
      configPath: ".claude/settings.json"
    };
  }
}
