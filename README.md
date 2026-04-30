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
kbx ingest
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

## Current Scope

Implemented:

- workspace init, registry list/forget/delete
- ingest/search/stats/reset/doctor/config
- source list/remove
- external import snapshots
- heading-aware Markdown chunking and fixed text/code chunking
- Zvec-backed local vector collection
- Transformers.js embeddings with a hash test embedder
- model catalog list/use/benchmark
- stdio MCP server

Not yet implemented:

- npm publishing workflow
- standalone binaries / Homebrew
- PDF/DOCX ingest
- reranking
- answer generation or chat
