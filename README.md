# kbx

`kbx` is a local-first knowledge base CLI for making workspace files searchable by AI assistants.

It stores workspace data under `.kbx/`, runs locally, and exposes retrieval through both CLI commands and a stdio MCP server.
Downloaded or offline-loaded model files are cached under the user-level kbx directory.

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
npm run release:preflight
npm run smoke:install
npm run package:binaries
npm run smoke:artifact
```

Use the deterministic hash embedder during development to avoid downloading model weights:

```bash
$env:KBX_EMBEDDER='hash' # PowerShell
```

## Basic Usage

```bash
kbx init
kbx init --choose-model
kbx init --model minilm
kbx init --git-root --model nomic
kbx ingest
kbx ingest docs --include "**/*.md" --exclude "drafts/**" --no-gitignore
kbx search "workspace registry"
kbx search "workspace registry" --fresh
kbx search "workspace registry" --global
kbx watch
kbx doctor --repair
kbx memory add "Decision: keep v1 retrieval-only." --retention-days 30
kbx memory list
kbx memory prune
kbx stats --fresh
kbx config set chunk.strategy sentence
kbx config set init.root_preference git-root --global
kbx model list
kbx model benchmark
kbx model load ./nomic-embed-text-v1.5 --as nomic
kbx model use
```

Supported ingest inputs include Markdown, plain text, PDF, DOCX, PPTX, XLSX, EPUB, images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.tif`, `.tiff`, `.bmp`), common source-code files, and structured text formats such as JSON, YAML, TOML, XML, SQL, HTML, and CSS.

Image ingest indexes embedded PNG text metadata and can run OCR when `tesseract` is available. To plug in a different OCR engine, set `KBX_OCR_COMMAND` to a command that writes extracted text to stdout; use `{file}` as the image path placeholder:

```bash
KBX_OCR_COMMAND='my-ocr --input {file}' kbx ingest screenshots
```

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

Generate client-specific snippets:

```bash
kbx mcp config --list
kbx mcp config claude
kbx mcp config cursor
kbx mcp config codex
kbx mcp config zed
kbx agent guide
kbx agent hooks claude-code
```

Claude Code hooks are generated directly. Other clients can integrate with the generic file refresh hook when they expose a stable post-edit lifecycle hook:

```bash
printf '{"paths":["src/app.ts"]}' | kbx hook files refresh
```

Tools exposed:

- `kbx_search`
- `kbx_search_global`
- `kbx_search_many`
- `kbx_list_sources`
- `kbx_get_chunk`
- `kbx_index_status`
- `kbx_agent_guide`
- `kbx_watch_status`
- `kbx_refresh_index`
- `kbx_refresh_file`
- `kbx_mcp_config`
- gated destructive tools: `kbx_remove_source`, `kbx_reset_index`, `kbx_forget_workspace`, `kbx_delete_workspace_kb`

`kbx_search` returns previews, chunk IDs, source citations, scores, match type, and bounded freshness metadata. It opportunistically refreshes changed indexed content when the change count is small; use `kbx_refresh_index` or `kbx watch` for larger updates. Use `kbx_get_chunk` to fetch full text for specific results. The MCP server also exposes a `kbx_usage` prompt and `kbx://usage` resource with agent guidance.

Search uses deterministic hybrid retrieval by default. Optional model or LLM reranking can be layered in with an external command:

```bash
kbx search "session timeout" --reranker local
kbx search "session timeout" --reranker command --reranker-command "node rerank.mjs"
```

`local` uses kbx's built-in deterministic source, phrase, proximity, and match-type reranking. The `command` mode reads one JSON object from stdin (`query` plus `candidates`) and writes either `{ "scores": { "<chunk-id>": 0.9 } }` or an array of `{ "id", "score" }`.

Retrieval quality can be measured before and after reranker changes with a JSON eval corpus:

```bash
kbx eval retrieval evals/retrieval.json -k 5
```

A tiny example corpus lives under `examples/retrieval-eval/`.

## Release Artifacts

`npm run package:binaries` creates a platform archive under `dist/artifacts/` with its own Node runtime, dependency tree, and `bin/kbx` launcher. `npm run smoke:artifact` extracts that archive and runs `kbx --version` from outside the repo. The release workflow builds Linux, macOS, and Windows archives, verifies checksums and required runtime payloads, emits GitHub artifact attestations, and uploads a generated Homebrew formula.

Release packaging has optional signing and notarization hooks:

- `KBX_SIGN_FILE_COMMAND` runs before the archive is written. Use it for platform runtime files such as the bundled Node executable.
- `KBX_SIGN_COMMAND` runs after the archive is written and before checksums are generated.
- `KBX_NOTARIZE_COMMAND` runs after archive signing and before checksums are generated.

Hook commands support `{file}`, `{artifact}`, `{package_root}`, `{platform}`, and `{arch}` placeholders where applicable. Set `KBX_SIGN_FILE_REQUIRED=1`, `KBX_SIGN_REQUIRED=1`, or `KBX_NOTARIZE_REQUIRED=1` in CI when a missing command should fail the release.

Destructive MCP tools are disabled by default. Enable them only when you want agents to perform delete/reset operations:

```bash
kbx config set mcp.destructive_tools enabled
```

See [docs/agent-usage.md](docs/agent-usage.md) for Claude/Codex/Cursor style usage guidance.

## Current Scope

This is pre-release alpha scope. The CLI is usable for local development, smoke testing, release preflight checks, and standalone Node-runtime platform archives.

Implemented:

- workspace init, registry list/forget/delete
- ingest/search/stats/reset/doctor/config
- global search across registered workspaces with `kbx search --global`
- doctor repair flow with `kbx doctor --repair`
- explicit search freshness with `kbx search --fresh`
- hot indexing with `kbx ingest --watch` or `kbx watch`
- source list/remove
- external import snapshots
- explicit retention-bound session memory source under `.kbx/sessions`
- PDF and DOCX text extraction during ingest
- ingest policy overrides with `--include`, `--exclude`, and `--no-gitignore`
- heading-aware Markdown, fixed text/code, and sentence chunking
- Zvec-backed local vector collection
- hybrid vector and SQLite FTS5 lexical retrieval
- deterministic retrieval enhancers with post-fusion reranking and query-centered snippets
- built-in local reranker mode plus optional external command reranker
- Transformers.js embeddings with a hash test embedder
- model catalog list/use/benchmark, benchmark cache, installed status, and offline load from a local model directory
- init-time model selection with `--model`, `--choose-model`, git-root prompts, and user-level root preference
- interactive model switch reindex prompt
- stdio MCP server
- expanded MCP read, maintenance, watch status, config, opportunistic freshness, and gated destructive tools
- MCP adapter config validation through `doctor`
- local agent guidance through `kbx agent guide`
- Claude Code hook adapter for refreshing kbx after Write/Edit/MultiEdit
- CI and npm release workflow with package dry-run validation
- release artifact checksums, install smoke test, standalone Node-runtime platform archive packaging, artifact smoke tests, provenance attestations, optional signing hook, and Homebrew formula generation
- conservative default secret/key/env-file exclusions during ingest
- example retrieval eval corpus

Non-goals:

- answer generation or chat; kbx stays a retrieval layer
- Node SEA-style single-file binaries while native addon dependencies require external runtime assets; standalone platform archives are the supported no-system-Node distribution path
