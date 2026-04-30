export const KBX_AGENT_GUIDE = `# kbx agent usage guide

Use kbx when the user asks about this workspace, prior decisions, local docs, implementation details, config keys, error strings, APIs, or filenames that may already be indexed.

Recommended workflow:
1. Call kbx_index_status when you are unsure whether an index exists or may be stale.
2. Call kbx_search before asking the user to paste files or before dumping broad shell output.
3. Start with top_k=5. Use top_k=10 only for broad discovery or ambiguous terms.
4. Treat kbx_search results as previews. Read the id, source, chunk_idx, score, match, and preview fields.
5. Call kbx_get_chunk for the specific ids you intend to rely on or quote.
6. Search again with exact symbols, config keys, error strings, filenames, or acronyms when the first query is too broad.
7. Prefer citing source and chunk_idx in your response. If source is "external:..." treat it as imported local context, not a repository path.

Do not use kbx as a substitute for live web lookup. It only retrieves local indexed workspace content.`;

