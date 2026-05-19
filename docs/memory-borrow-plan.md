# Memory Borrow Plan

Status: Complete as of May 17, 2026.

This plan keeps `kbx` as a local-first workspace knowledge layer while borrowing useful memory-system patterns that improve agent context solving.

## Principles

- Keep automatic capture opt-in.
- Keep full workspace content indexed through `.kbx`, not a background daemon.
- Prefer compact, cited retrieval over hidden prompt injection.
- Add memory lifecycle metadata before adding automatic deletion.
- Gate graph-expanded retrieval behind explicit options until evals prove it helps.

## Execution Plan Closure

1. [x] Progressive MCP search.
   - Add compact-first search output and ID-based expansion.
   - Preserve existing `kbx_get_chunk` behavior.

2. [x] Richer explicit memories.
   - Add memory `type`, `files`, `tags`, `source_chunk_ids`, and `supersedes`.
   - Keep `retention_days` required.
   - Store metadata in session-memory frontmatter so it remains local and inspectable.
   - Mark superseded notes as no longer latest instead of deleting them.
   - Keep active retrieval latest-only by default so stale retained notes remain auditable without polluting current context.
   - Provide a compact history view for supersession chains.

3. [x] Memory lifecycle scoring.
   - Compute deterministic retention scores from type salience, age, and expiry.
   - Surface scores in memory listing and MCP results.
   - Use scoring for visibility first; do not auto-delete non-expired memories.

4. [x] Optional graph-expanded retrieval.
   - Add graph chunk candidates as a third retrieval stream behind an option.
   - Merge graph candidates with vector and lexical candidates using deterministic fusion.
   - Keep default retrieval unchanged until quality evals justify enabling it.

5. [x] File-focused context and inspection.
   - Add an MCP tool for file-specific context retrieval and linked retained memories.
   - Add a read-only MCP inspection summary for sources, freshness, graph state, and retained-memory counts.
   - Add retained-memory verification so supporting chunk IDs can be traced back to indexed source context.

6. [x] Verification.
   - Add focused tests for progressive search, memory metadata, retention scoring, graph search expansion, file context, and inspection.
   - Run targeted tests before broader verification.

## Completed Surfaces

- `kbx_search` compact previews with `expand_ids` for progressive disclosure.
- `kbx search --json` for CLI access to chunk IDs and citations.
- Retained memory metadata: type, files, tags, supporting chunk IDs, supersession links, latest state, and retention score.
- Active search and file-focused context hide superseded notes by default, with explicit history flags.
- `kbx_memory_verify` and `kbx memory verify` for citation checks.
- `kbx_memory_history` and `kbx memory history` for supersession-chain audits.
- Optional graph-expanded search candidates behind explicit flags.
- `kbx_file_context` and `kbx_inspect` read surfaces.

## Verification Closure

- `npm run typecheck` passed.
- `npm test` passed with 182 tests.
- Dogfooding covered citation verification, supersession history, latest-only active retrieval, and branch-scoped retained-note search.

## Explicit Non-Goals

- No default hidden transcript recorder.
- No default context injection into every tool call.
- No large MCP tool surface copied from another system.
- No daemon/runtime dependency.
