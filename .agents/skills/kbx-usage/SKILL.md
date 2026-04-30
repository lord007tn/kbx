# kbx Usage

Use this skill when working in a repository that has a `kbx` MCP server or CLI available and the task benefits from local indexed workspace knowledge.

Prefer `kbx_search` before broad file dumping or asking the user to paste local context. Start with `top_k=5`; use `top_k=10` only for discovery. Treat search results as previews: inspect `id`, `source`, `chunk_idx`, `score`, `match`, and `preview`, then call `kbx_get_chunk` only for the results you will rely on.

Search again with exact symbols, filenames, routes, config keys, error strings, package names, and acronyms when the first query is broad. Cite `source` and `chunk_idx` in user-facing answers when they materially support the response.

Run `kbx_index_status` when index freshness is uncertain. Do not use `kbx` as live web search; it only retrieves local indexed content.
