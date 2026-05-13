# Session Rewind And Graph Memory

Status: Accepted and baseline implemented

`kbx` supports explicit compact memory notes, read-only session handoffs, opt-in durable sessions, snapshot-backed rewind, and deterministic graph-backed knowledge. These features stay separate from normal search indexing because they change storage, privacy, and provenance boundaries.

## Decision

Keep the retained-memory path compact and explicit. Store full-session and graph features in separate local SQLite sidecars behind opt-in configuration, retention policy, provenance, and tests that cover deletion and stale-context behavior.

## Full Session Capture

Full sessions use an append-only event store separate from the chunk index. Each event has a session ID, monotonic sequence number, timestamp, event type, tool name, bounded input/output payloads, affected file paths, privacy-redaction status, and optional file snapshots.

The storage is local SQLite under `.kbx/sessions.db`, not markdown files under `.kbx/sessions`. Large payloads are size capped. Secret redaction happens before persistence. Hook capture is opt-in because different hosts expose different lifecycle data.

## Session Rewind

There are two rewind levels:

- Read-only rewind: replay the event log and reconstruct what the agent saw or did at a point in time.
- Workspace rewind: restore files or index state to a prior point.

Read-only rewind requires event ordering, checkpoint markers, indexed-state version references, and CLI/MCP surfaces such as `kbx session list`, `kbx session show`, and `kbx session replay`.

Workspace rewind is higher risk. The baseline uses explicit file snapshots, dry-run previews, and exact confirmation. MCP apply is gated by `mcp.destructive_tools=enabled`.

## Graph Knowledge

Graph memory uses an entity and relation store with provenance back to chunks and memory notes. Minimum schema:

- nodes: stable ID, label, type, aliases, confidence, created/updated timestamps
- edges: source node, target node, relation type, confidence, provenance IDs, observed timestamp
- provenance: chunk IDs, memory IDs, session event IDs, source path, and branch metadata

Extraction starts deterministic for files, symbols, headings, packages, and retained memory. LLM extraction can be optional later, but it needs cost controls and validation. Reingest and source removal should rebuild or invalidate graph facts derived from deleted chunks. Graph-expanded retrieval can later become a third candidate stream merged with vector and lexical search through deterministic fusion.

## Phasing

1. Explicit compact retained notes and read-only handoff summaries. Implemented.
2. Opt-in session event store for selected adapters, with retention and redaction. Implemented.
3. Read-only session list/show/replay over the event store. Implemented.
4. Snapshot-backed workspace rewind with dry-run and confirmation. Implemented.
5. Deterministic entity graph over indexed chunks and retained notes. Implemented.
6. Optional LLM graph extraction and graph-expanded retrieval evaluation.

## Consequences

This keeps `kbx` as a local knowledge layer instead of a hidden agent recorder. It also avoids making search quality depend on unbounded transcripts, remote LLM extraction, or irreversible workspace rollback behavior.
