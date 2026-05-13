# kbx Claude Code plugin

This plugin connects Claude Code to `kbx` through MCP, adds a post-edit refresh hook, and includes a `kbx-dev-mode` skill for opt-in local dev reports.

Test locally from the repository root:

```bash
claude --plugin-dir ./plugins/claude-code/kbx
```

Install through the local marketplace:

```text
/plugin marketplace add ./
/plugin install kbx@kbx-tools
```

The plugin runs `npx -y kbx mcp`, so Node.js must be available and the `kbx` npm package must be reachable or installed in your environment.
