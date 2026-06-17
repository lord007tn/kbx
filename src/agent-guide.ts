export const KBX_AGENT_GUIDE = `# kbx agent usage guide

Use kbx when the user asks about this workspace, prior decisions, local docs, implementation details, config keys, error strings, APIs, or filenames that may already be indexed.

Recommended workflow:
1. Call kbx_index_status when you are unsure whether an index exists or may be stale.
2. Call kbx_watch_status when the user is actively editing files or asks whether live context is current or background watch is running.
3. Call kbx_session_handoff at session start or before handing work to another agent when you need a compact workspace/index summary.
4. Call kbx_context for task-level context that should come back grouped and bounded in one response.
5. Call kbx_search before asking the user to paste files or before dumping broad shell output.
6. Use kbx_search_global only when the user asks across projects or the relevant workspace is unknown.
7. kbx_search and kbx_context perform a bounded freshness refresh when the detected change count is small. If freshness is skipped or clearly stale, call kbx_refresh_file for a known file or kbx_refresh_index for a broader refresh.
8. Start with top_k=5. Use top_k=10 only for broad discovery or ambiguous terms.
9. Treat kbx_search results as previews. Read the id, source, chunk_idx, score, match, preview, and freshness fields.
10. Call kbx_search with expand_ids when you need several full chunks from previous compact results, or kbx_get_chunk for one specific id.
11. Use kbx_file_context when the user is editing or reviewing specific files and you need indexed file context plus linked retained memories.
12. Use kbx_inspect for a read-only local summary of sources, freshness, retained-memory counts, and graph availability.
13. Use kbx_graph_query for relationships between files, headings, symbols, dependencies, or retained memory. Use kbx_search with use_graph=true only when graph-expanded candidates are useful for the task.
14. Search again with exact symbols, config keys, error strings, filenames, or acronyms when the first query is too broad.
15. Prefer citing source and chunk_idx in your response. If source is "external:..." treat it as imported local context, not a repository path.

Memory workflow:
- Use kbx_memory_add only for compact decisions, preferences, architecture notes, bug lessons, workflows, handoffs, facts, or events worth retaining. Always set an explicit retention_days value.
- Include type, files, tags, source_chunk_ids, and supersedes when known; kbx uses this metadata for deterministic retention scoring and future retrieval.
- When supersedes is provided, the older retained note is marked as no longer latest instead of being deleted.
- Active search and file context omit superseded retained notes by default; request superseded notes only when auditing history.
- Use kbx_memory_list to inspect retained notes, kbx_memory_verify to check whether a note's source_chunk_ids still resolve to indexed context, and kbx_memory_history to inspect supersession chains. Retained notes are indexed as session-memory sources and are searchable like other chunks.
- Do not store full hidden transcripts in kbx_memory_add.

Dev report workflow:
- Dev reports are opt-in. Use kbx_dev_report_add only when dev.report=enabled or the user explicitly asks to save a report.
- Keep reports short: task, summary, issues, findings, good points, and next steps.
- Reports are local debug artifacts under .kbx/debug/reports and are not session memory unless separately indexed or saved.

Session workflow:
- Durable sessions are opt-in. Use kbx_session_record_event for explicit local event capture and kbx_session_checkpoint for named progress markers.
- Use kbx_session_search for captured session/thread event search. Set global=true to search registered workspace session stores across clients such as Codex and Claude Code.
- Use kbx_session_replay for read-only timelines.
- Use kbx_rewind_preview before rollback. kbx_rewind_apply is destructive and requires mcp.destructive_tools=enabled plus the exact preview token.

Destructive tools are disabled unless the workspace sets mcp.destructive_tools=enabled and the call includes the exact confirmation token returned by the tool error. Never guess confirmation tokens.

Do not use kbx as a substitute for live web lookup. It only retrieves local indexed workspace content.`;

export const KBX_MCP_INSTRUCTIONS = `Use kbx for local workspace knowledge before asking the user to paste files or running broad shell searches. Start with kbx_context for task-level context, kbx_search for focused lookup, kbx_graph_query for relationships, kbx_get_chunk for specific full chunks, and kbx_index_status or kbx_watch_status when freshness is uncertain. Use kbx_session_search when the user asks to search captured sessions or threads across tools such as Codex and Claude Code. Search results are local indexed or captured content, not live web data. Durable session capture and dev reports are opt-in. When dev.report=enabled and the user wants kbx dev-mode feedback, call kbx_dev_report_add near task completion with a short report. Destructive tools require mcp.destructive_tools=enabled and the exact confirmation token returned by the tool error.`;
