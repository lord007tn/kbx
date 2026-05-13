---
description: Use kbx as a local-first workspace knowledge base in Claude Code. Use when the user asks about local architecture, docs, decisions, symbols, errors, prior context, kbx dev mode, or opt-in kbx debug reports.
---

# kbx Dev Mode

Use the `kbx` MCP tools before asking the user to paste workspace files or running broad shell searches.

## Workflow

1. Check `kbx_index_status` or `kbx_watch_status` when freshness is uncertain.
2. Use `kbx_context` for task-level context and `kbx_search` for focused symbols, config keys, errors, docs, and filenames.
3. Use `kbx_get_chunk` only for specific chunks you need to rely on or cite.
4. Prefer source and chunk IDs in explanations when they clarify where local knowledge came from.

## Dev Reports

If `dev.report=enabled`, call `kbx_dev_report_add` near task completion with a compact report.

Include:

- task
- summary
- issues
- findings
- good
- next

Do not save hidden reasoning, full transcripts, secrets, raw tool logs, or unrelated project details. If the tool says reports are disabled, do not retry.

## Useful CLI Fallbacks

```bash
kbx context "query"
kbx search "query"
kbx watch --status
kbx config set dev.report enabled
kbx dev report add --task "..." --summary "..."
```
