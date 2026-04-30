# kbx

`kbx` is a local-first knowledge base CLI for making workspace files searchable by AI assistants.

It stores workspace data under `.kbx/`, runs locally, and exposes retrieval through both CLI commands and a stdio MCP server.

## Install

```bash
npm install
npm run build
```

## Development

```bash
npm run typecheck
npm test
npm run build
```

Use the deterministic hash embedder during development to avoid downloading model weights:

```bash
$env:KBX_EMBEDDER='hash' # PowerShell
```

## Basic Usage

```bash
kbx init
kbx init --model minilm
kbx init --git-root --model nomic
kbx ingest
kbx ingest docs --include "**/*.md" --exclude "drafts/**" --no-gitignore
kbx search "workspace registry"
kbx stats --fresh
```

Supported ingest inputs include Markdown, plain text, common source-code files, and structured text formats such as JSON, YAML, TOML, XML, SQL, HTML, and CSS.

External paths are rejected unless explicitly snapshotted into the workspace:

```bash
kbx ingest C:\Users\you\notes --allow-external
```

## MCP

Run the stdio MCP server from an initialized workspace:

```bash
kbx mcp
```

Claude Desktop / Cursor style config:

```json
{
  "mcpServers": {
    "kbx": {
      "command": "kbx",
      "args": ["mcp"]
    }
  }
}
```

Tools exposed:

- `kbx_search`
- `kbx_list_sources`
- `kbx_get_chunk`
- `kbx_index_status`

`kbx_search` returns previews, chunk IDs, source citations, scores, and match type. Use `kbx_get_chunk` to fetch full text for specific results. The MCP server also exposes a `kbx_usage` prompt and `kbx://usage` resource with agent guidance.

See [docs/agent-usage.md](docs/agent-usage.md) for Claude/Codex/Cursor style usage guidance.

## Current Scope

This is pre-release alpha scope. The CLI is usable for local development and smoke testing, but npm publishing, standalone binaries, and broader distribution hardening are still pending.

Implemented:

- workspace init, registry list/forget/delete
- ingest/search/stats/reset/doctor/config
- source list/remove
- external import snapshots
- ingest policy overrides with `--include`, `--exclude`, and `--no-gitignore`
- heading-aware Markdown chunking and fixed text/code chunking
- Zvec-backed local vector collection
- hybrid vector and lexical retrieval
- Transformers.js embeddings with a hash test embedder
- model catalog list/use/benchmark
- init-time model selection with `--model`
- stdio MCP server

Not yet implemented:

- npm publishing workflow
- standalone binaries / Homebrew
- PDF/DOCX ingest
- reranking
- answer generation or chat
