# kbx Agent Usage

Use `kbx` when an agent needs local workspace context instead of asking the user to paste files or dumping broad shell output.

## When to Search

- Before answering questions about local architecture, project conventions, decisions, APIs, config keys, or docs.
- When the user mentions an error string, symbol name, file name, package name, feature area, or acronym that may exist in the workspace.
- Before editing unfamiliar code if the relevant files or prior documentation are not already in context.

## Search Pattern

1. Check index health with `kbx_index_status` if freshness is uncertain.
2. Use `kbx_watch_status` during active editing sessions to inspect freshness and background watcher state.
3. Call `kbx_session_handoff` at session start or handoff when you need a compact workspace/index summary.
4. Call `kbx_search` with `top_k=5` for focused questions.
5. Use `top_k=10` for broad discovery or ambiguous terms.
6. Treat `kbx_search` results as previews. Use `id`, `source`, `chunk_idx`, `score`, `match`, `preview`, and `freshness` to decide what matters.
7. Call `kbx_search` with `expand_ids` when you need several full chunks, or `kbx_get_chunk` for one result you plan to quote, cite, or rely on.
8. Use `kbx_file_context` when editing or reviewing specific files and you need linked retained notes.
9. Use `kbx_inspect` for a read-only local summary of sources, freshness, retained memory, and graph state.
10. Search again with exact names when needed: symbols, config keys, error strings, filenames, routes, and package names.
11. Use `kbx_graph_query` when the task is about relationships between files, headings, symbols, dependencies, or retained memory.

`kbx_search` performs bounded opportunistic freshness when the detected change count is small. Use `kbx_refresh_file` when the relevant path is known, or `kbx_refresh_index` when the workspace has many changes. For continuous freshness, run `kbx watch` in a separate terminal or enable one background watcher with `kbx config set watch.auto enabled`.

## Memory Notes

Use `kbx_memory_add` only for compact decisions, preferences, architecture notes, bug lessons, workflows, handoffs, facts, and events the user would reasonably expect to persist. Every memory note requires `retention_days`; do not store full hidden transcripts or raw tool logs through this path.

Include `type`, `files`, `tags`, `source_chunk_ids`, and `supersedes` when known. Active search and file context omit superseded notes by default; request superseded notes only when auditing history.

Use `kbx_memory_list` to inspect retained notes, `kbx_memory_verify` to check supporting chunk citations, and `kbx_memory_history` to inspect supersession chains. Retained notes are stored under `.kbx/sessions`, indexed as `session-memory:*` sources, and retrieved through normal `kbx_search` calls.

## Dev Reports

Use `kbx_dev_report_add` only when the user has opted in with `dev.report=enabled` or explicitly asks to save a kbx dev report. Keep it short: task, summary, issues, findings, good points, and next steps. Reports are local debug artifacts under `.kbx/debug/reports`.

## Durable Sessions

Durable session capture is opt-in. Use `sessions.capture=metadata` for tool/event summaries and `sessions.capture=full` only when the user wants local raw payload capture. The session event store is separate from the search index and lives under `.kbx/sessions.db`.

Use `kbx_session_record_event` for explicit event capture, `kbx_session_checkpoint` for named progress markers, and `kbx_session_replay` for read-only timelines. Use `kbx_rewind_preview` before any rollback; `kbx_rewind_apply` is destructive and requires both `mcp.destructive_tools=enabled` and the exact preview token.

## Hook Support

Claude Code users can install the packaged plugin under `plugins/claude-code/kbx` or run `kbx agent hooks claude-code` to generate an additive `.claude/settings.json` hook snippet. The plugin includes MCP config, the same post-edit refresh hook, a `kbx-dev-mode` skill, and a `/kbx:kbx-status` command.

Use `kbx agent plugin claude-code` to print the local plugin path and install commands. Claude Desktop / Claude MCP config and Codex CLI should use `kbx mcp config claude` and `kbx mcp config codex`.

## Citation Behavior

By default MCP citations are safe workspace-relative paths or `external:` labels for imported sources. If `mcp.citations=full-path`, agents may receive full local paths. In user-facing answers, cite the `source` and `chunk_idx` when useful.

## What Not To Do

- Do not treat `kbx` as live web search.
- Do not request full text for every search hit by default; fetch only the chunks that are actually needed.
- Do not assume the index is fresh if `kbx_index_status` or `doctor --fresh` reports stale, deleted, or new files.
- Do not enable full session capture unless the user explicitly wants local raw payload retention.
- Do not apply a rewind unless the user has reviewed the preview and supplied or approved the exact confirmation token.
- Do not call destructive tools unless the user explicitly requested the operation and supplied/approved the required confirmation token.
