# kbx Implementation Status

Last reviewed: May 12, 2026

This document records what is already present in the current `kbx` codebase so the PRD can distinguish shipped foundation from planned expansion.

## Implemented

- npm CLI package named `kbx` with TypeScript ESM build.
- Workspace initialization under `.kbx/` with manifest, config, source manifest, collection path, and user-level registry.
- Workspace registry commands for listing, forgetting, and deleting workspace knowledge bases.
- Source management for listing and removing ingest sources.
- Conservative ingest policy for Markdown, plain text, common source files, generated-file exclusions, and structured text formats.
- PDF, DOCX, PPTX, XLSX, and EPUB text extraction during ingest.
- Image ingest for PNG/JPEG/WebP/GIF/TIFF/BMP extensions, with PNG text metadata extraction and optional OCR through `tesseract` or `KBX_OCR_COMMAND`.
- External import snapshots with `--allow-external`, stored under `.kbx/imports/`.
- Optional compact session memory source with explicit per-entry retention, stored under `.kbx/sessions/`.
- Opt-in durable session event store under `.kbx/sessions.db` with metadata/full capture modes, retention pruning, redaction, checkpoints, and read-only replay.
- Session rewind preview/apply from captured file snapshots with exact confirmation tokens.
- Deterministic graph knowledge store under `.kbx/graph.db`, rebuilt from indexed chunks with file, heading, symbol, package dependency, and retained-memory nodes.
- Heading-aware Markdown chunking, fixed text/code chunking, and sentence chunking.
- Zvec-backed local vector store with per-file delete and upsert.
- Transformers.js embedding pipeline with a deterministic hash embedder for tests.
- Embedding model catalog with install status, benchmark cache, offline model loading, and model switch reindex flow.
- Persistent SQLite lexical index stored under `.kbx/lexical.db` with FTS5 unicode and trigram indexes.
- Hybrid baseline search that combines vector results with SQLite lexical/BM25 matches.
- Deterministic retrieval enhancers: exact phrase/source boosts, proximity scoring, post-fusion reranking, and query-centered snippets.
- Optional Transformers.js model reranker and external command reranker contract for heavier model-based or LLM reranking experiments; disabled by default.
- Built-in local reranker mode for deterministic phrase, source, proximity, and match-type ordering.
- Retrieval quality eval command with MRR, hit rate, and recall@k over a JSON corpus.
- Example retrieval eval corpus under `examples/retrieval-eval/`.
- Global search across registered workspaces via `kbx search --global`.
- Workspace stats, freshness reporting, explicit search freshness, reset, doctor checks, lexical/vector consistency checks, and benchmark options.
- Doctor repair flow via `kbx doctor --repair`.
- Watch ingest mode using current workspace/source boundaries via `kbx ingest --watch` and `kbx watch`.
- Root `.kbxignore` support in addition to `.gitignore`.
- Git branch-scoped workspace indexing with current-branch search filtering and vector storage dedupe for identical chunk content.
- Session memory commands: `kbx memory add`, `kbx memory list`, and `kbx memory prune`.
- Durable session commands: `kbx session start`, `record`, `checkpoint`, `replay`, `events`, `end`, and `prune`.
- Rewind commands: `kbx rewind preview` and `kbx rewind apply`.
- Graph commands: `kbx graph build`, `kbx graph query`, and `kbx graph stats`.
- Stdio MCP server with read tools: `kbx_search`, `kbx_search_global`, `kbx_search_many`, `kbx_list_sources`, `kbx_get_chunk`, `kbx_index_status`, `kbx_agent_guide`, `kbx_memory_list`, `kbx_session_handoff`, `kbx_session_list`, `kbx_session_show`, `kbx_session_events`, `kbx_session_replay`, `kbx_rewind_preview`, `kbx_graph_query`, and `kbx_graph_stats`.
- MCP retained-memory write tool: `kbx_memory_add`, which saves explicit compact notes with required retention and indexes them as session-memory sources.
- MCP durable-session write tools: `kbx_session_record_event` and `kbx_session_checkpoint`.
- MCP graph rebuild tool: `kbx_graph_build`.
- MCP maintenance tools: `kbx_refresh_index`, `kbx_refresh_file`, `kbx_watch_status`, and `kbx_mcp_config`.
- MCP search opportunistically refreshes stale indexed content when the detected change count is within the bounded MCP refresh budget.
- Gated destructive MCP tools: `kbx_remove_source`, `kbx_reset_index`, `kbx_forget_workspace`, `kbx_delete_workspace_kb`, and `kbx_rewind_apply`.
- MCP prompt/resource guidance for agent usage.
- Local agent usage guidance via `kbx agent guide`.
- MCP config snippet adapters for Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, VS Code Copilot, JetBrains Copilot, Zed, OpenCode, Kilo, Kiro, Qwen Code, Antigravity, and Pi.
- Claude Code hook adapter via `kbx agent hooks claude-code`, plus a `kbx hook claude-code post-tool-use` handler that refreshes edited files after Write/Edit/MultiEdit.
- Generic `kbx hook files refresh` handler for clients that expose stable post-edit hooks but do not yet have a first-class adapter.
- MCP adapter config template validation in `doctor`.
- Test coverage for adapters, chunking, config, files, indexing, MCP tools, source handling, model catalog, search, vector store, and workspace behavior.
- CI and npm release workflow with enforced npm package content validation, install smoke tests, npm provenance publishing, and `changelogithub` GitHub releases.
- Release preflight script that runs typecheck, tests, build, and install smoke checks.
- Conservative default ingest exclusions for env files, common private keys/certificates, password databases, and `secrets/` directories.
- Local project benchmark script for comparing embedder and reranker variants across real workspaces.

## Verified Locally

- `npm run typecheck` passes.
- `npm test` passes with the current test suite.
- `npm run build` passes.

## Known Gaps

- First-class hook adapter coverage beyond Claude Code still depends on which clients expose stable post-edit lifecycle hooks.
- Session capture is opt-in and local; full automatic host transcript capture still depends on each agent/client exposing stable lifecycle hooks.
- Cross-encoder or LLM reranking can be integrated through the command reranker contract, but kbx does not bundle a heavy cross-encoder or generator.
- Standalone binaries, platform archives, signing/notarization, and Homebrew packaging are out of scope; npm/npx is the supported distribution path.
- Answer generation and chat are permanent non-goals; kbx remains a retrieval layer for tools such as Codex and Claude.
