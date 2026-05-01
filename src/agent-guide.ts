export const KBX_AGENT_GUIDE = `# kbx agent usage guide

Use kbx when the user asks about this workspace, prior decisions, local docs, implementation details, config keys, error strings, APIs, or filenames that may already be indexed.

Recommended workflow:
1. Call kbx_index_status when you are unsure whether an index exists or may be stale.
2. Call kbx_watch_status when the user is actively editing files or asks whether live context is current.
3. Call kbx_search before asking the user to paste files or before dumping broad shell output.
4. Use kbx_search_global only when the user asks across projects or the relevant workspace is unknown.
5. kbx_search performs a bounded freshness refresh when the detected change count is small. If freshness is skipped or clearly stale, call kbx_refresh_file for a known file or kbx_refresh_index for a broader refresh.
6. Start with top_k=5. Use top_k=10 only for broad discovery or ambiguous terms.
7. Treat kbx_search results as previews. Read the id, source, chunk_idx, score, match, preview, and freshness fields.
8. Call kbx_get_chunk for the specific ids you intend to rely on or quote.
9. Search again with exact symbols, config keys, error strings, filenames, or acronyms when the first query is too broad.
10. Prefer citing source and chunk_idx in your response. If source is "external:..." treat it as imported local context, not a repository path.

Destructive tools are disabled unless the workspace sets mcp.destructive_tools=enabled and the call includes the exact confirmation token returned by the tool error. Never guess confirmation tokens.

Do not use kbx as a substitute for live web lookup. It only retrieves local indexed workspace content.`;
