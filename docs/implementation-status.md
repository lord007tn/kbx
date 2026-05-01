# kbx Implementation Status

Last reviewed: May 1, 2026

This document records what is already present in the current `kbx` codebase so the PRD can distinguish shipped foundation from planned expansion.

## Implemented

- npm CLI package named `kbx` with TypeScript ESM build.
- Workspace initialization under `.kbx/` with manifest, config, source manifest, collection path, and user-level registry.
- Workspace registry commands for listing, forgetting, and deleting workspace knowledge bases.
- Source management for listing and removing ingest sources.
- Conservative ingest policy for Markdown, plain text, common source files, and structured text formats.
- PDF, DOCX, PPTX, XLSX, and EPUB text extraction during ingest.
- Image ingest for PNG/JPEG/WebP/GIF/TIFF/BMP extensions, with PNG text metadata extraction and optional OCR through `tesseract` or `KBX_OCR_COMMAND`.
- External import snapshots with `--allow-external`, stored under `.kbx/imports/`.
- Optional compact session memory source with explicit per-entry retention, stored under `.kbx/sessions/`.
- Heading-aware Markdown chunking, fixed text/code chunking, and sentence chunking.
- Zvec-backed local vector store with per-file delete and upsert.
- Transformers.js embedding pipeline with a deterministic hash embedder for tests.
- Embedding model catalog with install status, benchmark cache, offline model loading, and model switch reindex flow.
- Persistent SQLite lexical index stored under `.kbx/lexical.db` with FTS5 unicode and trigram indexes.
- Hybrid baseline search that combines vector results with SQLite lexical/BM25 matches.
- Deterministic retrieval enhancers: exact phrase/source boosts, proximity scoring, post-fusion reranking, and query-centered snippets.
- Optional external command reranker contract for model-based or LLM reranking experiments; disabled by default.
- Retrieval quality eval command with MRR, hit rate, and recall@k over a JSON corpus.
- Workspace stats, freshness reporting, explicit search freshness, reset, doctor checks, lexical/vector consistency checks, and benchmark options.
- Watch ingest mode using current workspace/source boundaries via `kbx ingest --watch` and `kbx watch`.
- Session memory commands: `kbx memory add`, `kbx memory list`, and `kbx memory prune`.
- Stdio MCP server with read tools: `kbx_search`, `kbx_search_many`, `kbx_list_sources`, `kbx_get_chunk`, `kbx_index_status`, and `kbx_agent_guide`.
- MCP maintenance tools: `kbx_refresh_index`, `kbx_refresh_file`, `kbx_watch_status`, and `kbx_mcp_config`.
- MCP search opportunistically refreshes stale indexed content when the detected change count is within the bounded MCP refresh budget.
- Gated destructive MCP tools: `kbx_remove_source`, `kbx_reset_index`, `kbx_forget_workspace`, and `kbx_delete_workspace_kb`.
- MCP prompt/resource guidance for agent usage.
- Local agent usage guidance via `kbx agent guide`.
- MCP config snippet adapters for Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, VS Code Copilot, JetBrains Copilot, Zed, OpenCode, Kilo, Kiro, Qwen Code, Antigravity, and Pi.
- Claude Code hook adapter via `kbx agent hooks claude-code`, plus a `kbx hook claude-code post-tool-use` handler that refreshes edited files after Write/Edit/MultiEdit.
- Generic `kbx hook files refresh` handler for clients that expose stable post-edit hooks but do not yet have a first-class adapter.
- MCP adapter config template validation in `doctor`.
- Test coverage for adapters, chunking, config, files, indexing, MCP tools, source handling, model catalog, search, vector store, and workspace behavior.
- CI and npm release workflow with package dry-run validation, install smoke tests, standalone Node-runtime platform archive artifacts, artifact smoke tests, checksums, checksum verification, GitHub artifact attestations, optional signing hook, generated Homebrew formula, and npm provenance publishing.

## Verified Locally

- `npm run typecheck` passes.
- `npm test` passes with 94 tests.
- `npm run build` passes.

## Known Gaps

- Single-file SEA-injected binaries remain future work; current platform archives are standalone because they include their own Node runtime and dependency tree.
- First-class hook adapter coverage beyond Claude Code still depends on which clients expose stable post-edit lifecycle hooks.
- The optional reranker contract exists, but no built-in cross-encoder or LLM reranker model is bundled.
- Answer generation and chat are intentionally out of scope while kbx remains a retrieval layer for tools such as Codex and Claude.
