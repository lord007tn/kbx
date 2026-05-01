# kbx Agent Usage

Use `kbx` when an agent needs local workspace context instead of asking the user to paste files or dumping broad shell output.

## When to Search

- Before answering questions about local architecture, project conventions, decisions, APIs, config keys, or docs.
- When the user mentions an error string, symbol name, file name, package name, feature area, or acronym that may exist in the workspace.
- Before editing unfamiliar code if the relevant files or prior documentation are not already in context.

## Search Pattern

1. Check index health with `kbx_index_status` if freshness is uncertain.
2. Use `kbx_watch_status` during active editing sessions to inspect freshness and watcher guidance.
3. Call `kbx_search` with `top_k=5` for focused questions.
4. Use `top_k=10` for broad discovery or ambiguous terms.
5. Treat `kbx_search` results as previews. Use `id`, `source`, `chunk_idx`, `score`, `match`, `preview`, and `freshness` to decide what matters.
6. Call `kbx_get_chunk` for each result you plan to quote, cite, or rely on.
7. Search again with exact names when needed: symbols, config keys, error strings, filenames, routes, and package names.

`kbx_search` performs bounded opportunistic freshness when the detected change count is small. Use `kbx_refresh_file` when the relevant path is known, or `kbx_refresh_index` when the workspace has many changes. For continuous freshness, run `kbx watch` in a separate terminal.

## Hook Support

Claude Code users can run `kbx agent hooks claude-code` to generate an additive `.claude/settings.json` hook snippet. The hook runs after successful Write/Edit/MultiEdit operations and refreshes the edited file in the local kbx index.

## Citation Behavior

By default MCP citations are safe workspace-relative paths or `external:` labels for imported sources. If `mcp.citations=full-path`, agents may receive full local paths. In user-facing answers, cite the `source` and `chunk_idx` when useful.

## What Not To Do

- Do not treat `kbx` as live web search.
- Do not request full text for every search hit by default; fetch only the chunks that are actually needed.
- Do not assume the index is fresh if `kbx_index_status` or `doctor --fresh` reports stale, deleted, or new files.
- Do not call destructive tools unless the user explicitly requested the operation and supplied/approved the required confirmation token.
