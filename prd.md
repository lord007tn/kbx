# PRD — `kbx`: Local-First Knowledge Base CLI

**Status:** Draft v1
**Owner:** TBD
**Last updated:** April 30, 2026

---

## 1. Summary

`kbx` is a local-only command-line tool that turns a workspace into a searchable knowledge base for AI assistants. It runs on a laptop with no servers, no cloud calls, and no Python. v1 is CPU-only.

The public npm package and CLI binary are both `kbx`. Workspace data lives under `.kbx/`, and MCP tools use the `kbx_` prefix.

Primary user flow:

```
kbx ingest                # index the current workspace knowledge base
kbx search "..."          # retrieve top chunks from the current workspace
kbx mcp                   # serve to Claude / Cursor / any MCP client
```

---

## 2. Problem

Existing local RAG setups require Python, Docker, Ollama, or a vector database server. None are realistic for a non-developer who just wants their notes searchable by an AI. Cloud-hosted alternatives (Pinecone, Qdrant Cloud, OpenAI embeddings) require API keys, send data off-device, and cost money at scale. There is no "SQLite for AI knowledge" — a zero-config, single-binary, fully local tool — for the Node.js ecosystem.

## 3. Goals

- **Zero friction to install.** One command (`npm i -g kbx` or `npx kbx`) on macOS, Linux, or Windows.
- **Zero friction to run.** No config required for the default path. Sensible defaults end-to-end.
- **Fully local.** No network calls after the first model download. Works offline.
- **CPU-only in v1.** Runs embeddings on CPU by default. GPU acceleration is a later optimization, not a v1 promise.
- **Useful to AI.** Exposes itself as an MCP server so Claude, Cursor, and similar tools can query it directly.
- **Light enough for a 4-year-old laptop.** <500 MB RAM at query time, <2 s cold start, default model under 200 MB on disk.

## 4. Non-goals (v1)

- Multi-user / shared-server deployments
- Cloud sync or hosted backends
- A GUI app
- Real-time collaborative editing
- Built-in LLM inference for answer generation (we retrieve; the user's AI generates)
- Reranking in the default retrieval pipeline
- Document formats beyond markdown, plain text, and code in v1
- Fine-tuning support

## 5. Target users

| User | Need | Success looks like |
|---|---|---|
| Developer with a notes folder | Searchable across years of markdown | `kbx search` returns the right chunk in <1 s |
| Claude / Cursor user | AI that can search their personal docs | One-line MCP config; assistant cites their notes |
| Researcher | Local-only RAG for sensitive material | Air-gapped machine, still works |
| Curious tinkerer | Try a vector DB without Docker | `npx kbx` works on first try |

## 6. User experience

### 6.1 Commands (MVP)

```
kbx init                          # create .kbx/ for the current workspace
kbx ingest [path] [--watch]       # index this workspace, or a specific path when provided; prompts to init if needed
kbx search "<query>" [-k 5]       # print top-k chunks from this workspace
kbx mcp                           # run as MCP server over stdio
kbx workspace list                # list registered workspaces
kbx workspace forget <selector>   # remove a workspace from the registry only
kbx workspace delete <selector>   # delete a workspace .kbx/ after confirmation
kbx sources list                  # list ingest roots and import snapshots
kbx sources remove <selector>     # remove a source entry and its indexed chunks
kbx stats                         # show doc count, index size, model
kbx stats --fresh                 # scan for stale/deleted files without reindexing
kbx config get|set <key> [value]  # view/edit config
kbx reset                         # clear current workspace index, preserving config and identity
kbx doctor                        # diagnose env, model downloaded, workspace health, etc.
kbx doctor --fresh                # include filesystem freshness scan
kbx doctor --bench                # include local embedding/index benchmark
kbx doctor --deep                 # include fresh + bench + registry repair suggestions
```

### 6.2 First-run experience

```
$ npx kbx ingest
! No kbx workspace found.
? Initialize one now? yes
✓ Detected: macOS arm64, CPU embeddings
✓ Downloading nomic-embed-text-v1.5 (137 MB)... done
✓ Found 247 markdown files
✓ Chunked into 1,891 segments
✓ Embedded on CPU in 58 s
✓ Index built. Try: kbx search "..."
```

Everything happens with one command. The model download is the only one-time cost.

### 6.3 MCP integration

The `kbx mcp` command runs an MCP server over stdio. v1 does not expose an SSE or HTTP transport. A user adds this to Claude Desktop or Cursor:

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

Then Claude can call `kbx_search`, `kbx_list_sources`, etc. as tools.

## 7. Technical architecture

### 7.1 Stack decisions

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict), Node ≥20 LTS | Asked for; Node 20 has stable fetch, test runner, ESM. |
| Vector store | `@zvec/zvec` | In-process, no server, native bindings already published for Linux x64/ARM64 + macOS ARM64. Matches "lightweight" goal. |
| Embeddings | `@huggingface/transformers` v3 (Transformers.js) | Pure JS surface; runs ONNX on CPU in v1. No Python, no Ollama. |
| ONNX backend | `onnxruntime-node` (bundled by Transformers.js) | CPU execution provider in v1. GPU execution providers are deferred. |
| CLI args | `commander` | Stable, tiny, well-known. Citty was considered; less ecosystem. |
| Prompts (config wizard) | `@clack/prompts` | Lighter than full Ink for one-off prompts. |
| Markdown parsing | `gray-matter` + `remark` | Frontmatter + AST traversal for smart chunking on heading boundaries. |
| File watching | `chokidar` | Defacto standard. |
| MCP server | `@modelcontextprotocol/sdk` | Official SDK, stdio transport. |
| Logging | `pino` (silent by default) | Structured logs to file, never stdout unless `--verbose`. |
| Tests | Node built-in test runner + `tsx` | No Jest. Keep deps minimal. |
| Build | `tsup` | Single-file ESM bundle. |
| Distribution | npm package; later: Node SEA single-binary | npm covers v1; SEA in v1.1 for non-Node users. |

### 7.2 Platform support

v1 platform support follows the published `@zvec/zvec` native bindings:

| Platform | v1 support |
|---|---|
| macOS Apple Silicon | Supported |
| Linux x64 | Supported |
| Linux ARM64 | Supported |
| Windows x64 | Supported |
| macOS Intel | Unsupported in v1 |
| Windows ARM | Unsupported in v1 |

### 7.3 Retrieval-only search

`kbx search` returns relevant chunks and human-readable source metadata. MCP tools return privacy-preserving citation metadata. Neither surface synthesizes answers. The `ask` command name is reserved for a later integration with tools like Codex CLI or Claude CLI, where a user's existing AI subscription can generate answers from retrieved local context.

`kbx search` is a fast read against the current index. It does not scan the filesystem, refresh stale files, or auto-ingest changes before querying in v1. Users refresh explicitly with `kbx ingest` or `kbx ingest --watch`. `kbx stats` and `kbx doctor` surface freshness information.

MCP search follows the same rule: no auto-refresh or filesystem scan during tool calls. The v1 MCP server is read-only.

### 7.4 Why Transformers.js over Ollama

Ollama is great but adds a separate install, a background daemon, and a network call. Transformers.js runs the model in-process, in pure JS. A user installs `kbx` and has embeddings — no second tool to install. Quality is identical because the underlying model weights are the same; only the runtime differs.

### 7.5 CPU strategy

v1 runs embeddings on CPU only. GPU acceleration through CoreML, CUDA, DirectML, or WebGPU is deferred until after the core workspace retrieval flow is stable and benchmarked.

`kbx doctor` reports CPU embedding support, model cache state, workspace health, and benchmark results. It may report detected GPU hardware later, but v1 does not select a GPU execution provider.

### 7.6 Embedding model catalog

v1 exposes supported embedding models as a catalog rather than asking users to type arbitrary model names. The catalog shows model size, dimensions, benchmark results, and a plain-language tradeoff.

Commands:

```bash
kbx model list
kbx model benchmark
kbx model benchmark <model-id>
kbx model benchmark --all
kbx model use <model-id>
```

Initial catalog:

| Model ID | Dim | Approx size | Profile | When to pick |
|---|---:|---:|---|---|
| `minilm` (`Xenova/all-MiniLM-L6-v2`) | 384 | ~23 MB | fast | Smallest download and fastest CPU ingest |
| `nomic` (`nomic-ai/nomic-embed-text-v1.5`) | 768 | ~137 MB | balanced | Better retrieval quality with still-reasonable CPU cost |
| `bge-base` (`Xenova/bge-base-en-v1.5`) | 768 | TBD | balanced/quality | English-focused retrieval quality |
| `qwen3-0.6b` (`Qwen/Qwen3-Embedding-0.6B`) | 1024 | TBD | quality | Highest quality candidate that may still run on CPU |

`kbx model list` displays machine-level benchmark data when available and bundled reference estimates otherwise:

```text
ID          Size     Dim   Speed          Profile    Installed
minilm      23 MB    384   120 chunks/s   fast       no
nomic      137 MB    768    45 chunks/s   balanced   yes
bge-base     TBD     768       untested   quality    no
```

`kbx model benchmark` benchmarks the current workspace's selected model and records results in a user-level machine benchmark cache. `kbx model benchmark <model-id>` benchmarks one candidate model. `kbx model benchmark --all` downloads and benchmarks every catalog model only after confirmation, because it may be slow and download large model files.

The default model is chosen from the catalog based on measured balance of download size, CPU ingest speed, memory, and retrieval quality. Until benchmark data says otherwise, `nomic` remains the provisional default. Model selection is stored per workspace; benchmark speed and load metrics are shared per machine.

Switching models requires a rebuild because vectors are not interchangeable across models. `kbx model use <model-id>` is transactional: if indexed content already exists, it prompts to reindex the current workspace before committing the model change. If the user declines, the selected model and index remain unchanged. In non-interactive mode, model switching requires an explicit `--reindex` flag. Model switch reindex rebuilds from `.kbx/sources.json`.

### 7.7 Workspace scoping

v1 scopes each knowledge base to the initialized workspace where `kbx` is run. An initialized workspace is marked by a `.kbx/` directory. Running `kbx` from `/work/project-a` or one of its subdirectories searches and serves `/work/project-a/.kbx/`; running it from `/work/project-b` searches and serves `/work/project-b/.kbx/`. `kbx ingest` adds or updates sources inside the current workspace knowledge base, not a user-global corpus. When no path is provided, it ingests the current initialized workspace root. Passing a path narrows ingest to that file or folder inside the same workspace knowledge base.

By default, `kbx ingest [path]` only accepts paths inside the current initialized workspace. If a user passes an external path, they must opt in with `--allow-external`. External ingest snapshots the selected files into `.kbx/imports/` first, then indexes the copied files from inside the workspace; `kbx` does not index external paths in place.

Commands locate the current workspace by walking upward from the current directory to find the nearest `.kbx/`. If no `.kbx/` exists, commands fail with a clear message to run `kbx init`; they do not silently infer a workspace from git metadata.

`kbx init` creates a `.kbx/` directory and registers the workspace. By default, `kbx init` proposes the current directory as the workspace root. If a git root is detected above the current directory, it prompts the user to choose between the current directory and the git root. Users can configure this default so `kbx init` prefers the detected git root, while still allowing an explicit opt-out for the current directory.

`kbx ingest [path]` may enter the same initialization prompt when no workspace is found, then continue ingest after the user chooses a workspace root. It must not silently create `.kbx/`; in non-interactive mode it exits unless initialization is explicitly requested.

Non-interactive init supports explicit root selection:

```bash
kbx init --here
kbx init --git-root
kbx init <path>
```

If the initialized workspace is a git repository, `kbx init` adds `.kbx/` to `.gitignore` when it is not already ignored.

`kbx` also maintains a user-level workspace registry so known workspaces can be listed and forgotten from outside their directory. The registry stores workspace locations and metadata, not a merged global index. A later global search mode can query registered workspace knowledge bases in parallel.

Multiple named collections inside one workspace are out of scope for v1.

Each workspace gets a CUID2 `workspace_id` in `.kbx/manifest.json`. The ID is the stable machine identity used by the registry. The registry also stores a human-readable name, usually derived from the workspace directory name, plus the absolute path for display and discovery.

Workspace names are not required to be unique. Commands that accept a workspace selector must support full or short workspace ID and path. A name is accepted only when it resolves to exactly one registered workspace; ambiguous names fail with a message asking for ID or path.

`kbx workspace forget <selector>` removes only the registry entry and leaves the workspace `.kbx/` directory intact. `kbx workspace delete <selector>` deletes the selected workspace's `.kbx/` directory and requires explicit confirmation.

`kbx reset` is scoped to the current initialized workspace. It clears indexed content and derived collection files, but preserves `.kbx/config.json`, `manifest.json`, workspace ID, workspace name, and the registry entry. It is used when rebuilding the current index, not when removing the workspace.

### 7.8 Storage layout

The storage location must preserve workspace scoping:

```
<workspace>/.kbx/
├── config.json                     workspace settings
├── manifest.json                   {workspace_id, name, model, dim, schema_version}
├── sources.json                    ingest roots and import snapshots
├── imports/                        copied files from --allow-external
└── collection/                     Zvec collection directory
    └── ...                         Zvec internal files
```

Downloaded model weights may use the normal Hugging Face cache and be shared across workspaces. The `manifest.json` records the workspace ID, display name, embedding model, and dimension for the workspace knowledge base. Every command checks the model and dimension before opening the collection — prevents silent corruption from a model swap.

`.kbx/sources.json` records the ingest roots and import snapshots that define the workspace's searchable corpus:

```json
[
  { "path": ".", "kind": "workspace", "include": [], "exclude": [] },
  { "path": "docs", "kind": "workspace", "include": [], "exclude": [] },
  {
    "path": ".kbx/imports/<source_path_hash>/files",
    "kind": "external_import",
    "original_path": "/Users/alice/notes",
    "imported_at": "2026-04-30T10:00:00.000Z"
  }
]
```

Rebuild operations, including model switch reindex, use `sources.json` rather than implicitly scanning the entire workspace.

`sources.json` is normalized after each ingest. When a broader workspace root covers an existing narrower workspace root, the broader root replaces the child entry. For example, after `kbx ingest docs`, a later `kbx ingest` records only `{ "path": ".", "kind": "workspace" }` for workspace files.

The reverse is a targeted refresh, not a narrowing operation. If `{ "path": ".", "kind": "workspace" }` already exists, `kbx ingest docs` refreshes indexed chunks under `docs` but leaves the broader root in `sources.json`. Narrowing the corpus requires an explicit source-management command later.

v1 includes minimal source management:

```bash
kbx sources list
kbx sources remove <selector>
```

`kbx sources remove <selector>` removes a source entry from `sources.json` and deletes indexed chunks for that source immediately after confirmation. It leaves original workspace files on disk untouched. If the selected path is covered by a broader source entry, the command refuses because removing the child path would not change future rebuilds while the broader root remains.

For external imports, `kbx sources remove` also asks whether to delete the copied `.kbx/imports/<source_path_hash>/` snapshot. Declining removes the source entry and indexed chunks but leaves the snapshot on disk.

The user-level registry maps workspace IDs to display metadata:

```json
{
  "workspace_id": "tz4a98xxat96iws9zmbrgj3a",
  "name": "project-a",
  "path": "/work/project-a",
  "created_at": "2026-04-30T10:00:00.000Z",
  "last_seen_at": "2026-04-30T10:00:00.000Z"
}
```

### 7.9 Schema (Zvec collection)

Validated against `@zvec/zvec` 0.3.2: the Node SDK supports scalar metadata fields, `VECTOR_FP32`, HNSW with cosine metric, output field selection, persistent create/open by filesystem path, query filters, and delete-by-filter. Zvec filter equality uses SQL-like `=`, not JavaScript-style `==`.

```ts
{
  name: "kbx_chunks",
  fields: [
    { name: "text",            dataType: ZVecDataType.STRING },
    { name: "source",          dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
    { name: "human_source",    dataType: ZVecDataType.STRING },
    { name: "citation_source", dataType: ZVecDataType.STRING },
    { name: "source_origin",   dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
    { name: "chunk_idx",       dataType: ZVecDataType.INT32 },
    { name: "mtime",           dataType: ZVecDataType.INT64 },
    { name: "tags",            dataType: ZVecDataType.STRING },
  ],
  vectors: [
    {
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 768,                           // varies by model
      indexParams: {
        indexType: ZVecIndexType.HNSW,
        metricType: ZVecMetricType.COSINE
      }
    }
  ]
}
```

### 7.10 Ingest policy

v1 uses a conservative default ingest policy. It respects `.gitignore`, uses built-in excludes, and indexes only text-like file types.

Included by default:
- Markdown and prose: `.md`, `.mdx`, `.txt`
- Common source files: TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, C#, Ruby, PHP, Swift, Kotlin, Shell, SQL, HTML, CSS, JSON, YAML, TOML, XML

Always excluded:
- `.git/`
- `.kbx/` except `.kbx/imports/`
- dependency directories such as `node_modules/`, `vendor/`
- build/cache output such as `dist/`, `build/`, `.next/`, `.turbo/`, `coverage/`
- binary files and files that fail text detection

Advanced users can override defaults with `--include`, `--exclude`, and `--no-gitignore`.

External paths are rejected unless `--allow-external` is passed. With `--allow-external`, files are copied into `.kbx/imports/` before indexing so the workspace remains the source of truth for indexed content without polluting the visible project tree. External import is a snapshot in v1: later changes at the original external path are not synced automatically. Re-running `kbx ingest <external-path> --allow-external` imports a new snapshot.

External import storage is deterministic by original absolute path:

```
.kbx/imports/
└── <source_path_hash>/
    ├── manifest.json               {original_path, imported_at}
    └── files/
        └── ...
```

Re-importing the same absolute source path replaces that snapshot before indexing, so repeated imports do not duplicate content. Importing the same files from a different absolute path creates a separate snapshot.

`kbx ingest` indexes normal workspace files plus managed imports in `.kbx/imports/`. No other `.kbx/` content is indexable: config, manifests, logs, caches, and collection files are always excluded.

Search results use human-readable sources. Workspace files display their workspace-relative path. External imports display the original external path plus the imported file's relative path in local CLI output, not the internal `.kbx/imports/<hash>/...` location.

MCP citations use `citation_source`, which hides absolute external paths by default. For external imports, citations use a safe label such as `external: notes/design/foo.md`; for workspace files, citations can use workspace-relative paths. Internal reindex and deletion still use the `source` field.

MCP citation behavior is configurable per workspace:

```bash
kbx config set mcp.citations safe       # default
kbx config set mcp.citations full-path  # expose precise paths to MCP clients
```

`safe` hides absolute external paths. `full-path` exposes full workspace-relative paths and full original external paths so MCP clients can open or reference files precisely.

### 7.11 Chunking

Default: heading-aware for markdown and fixed-size text-aware chunking for plain text and source code. Walk the markdown AST; emit one chunk per leaf section, splitting further if a section exceeds `max_chunk_chars` (default 800). Adjacent chunks share a 100-char overlap. Code blocks are kept intact (never split mid-block).

Configurable: `kbx config set chunk.size 800`, `kbx config set chunk.overlap 100`, `kbx config set chunk.strategy heading|fixed|sentence`.

### 7.12 Incremental reindex

Each chunk's ID is `hash(filepath + chunk_index)`. On reingest:
1. List markdown files; check `mtime` against stored values.
2. For changed files: delete by filter `source = '<path>'`, then re-embed and insert.
3. For deleted files: delete by filter.
4. Untouched files: skip entirely.

This makes `--watch` mode cheap.

`kbx ingest --watch` has the same workspace boundaries as normal ingest. It watches the current manifest sources, or the provided ingest target after the initial ingest. It does not watch original external paths. If `.kbx/imports/` snapshots are present in `sources.json`, it watches those copied files. It respects the same ingest policy and does not mutate `sources.json` after startup except for the initial ingest target.

### 7.13 Stats and freshness

`kbx stats` is cheap by default and reports stored metadata:

- workspace name and short ID
- selected model
- indexed source count
- document/chunk count
- last ingest time
- index size on disk

`kbx stats --fresh` scans source mtimes and deleted files, then reports stale/deleted counts without reindexing.

`kbx doctor` runs moderate diagnostics by default:

- workspace initialized
- manifest/config valid
- Zvec collection opens
- selected model is available or downloadable
- current platform is supported
- registry entry is valid
- stored stats are available

Expensive checks are explicit: `kbx doctor --fresh` scans source mtimes and deletions, `kbx doctor --bench` runs local embedding/index benchmarks, and `kbx doctor --deep` combines freshness, benchmark, and registry repair suggestions.

### 7.14 MCP server surface

```ts
tools = [
  {
    name: "kbx_search",
    description: "Search the user's personal knowledge base by semantic similarity.",
    parameters: { query: string, top_k?: number, filter?: string }
  },
  {
    name: "kbx_list_sources",
    description: "List indexed source files."
  },
  {
    name: "kbx_get_chunk",
    description: "Fetch a specific chunk by id (e.g. for citation expansion)."
  },
  {
    name: "kbx_index_status",
    description: "Report workspace index status, including last ingest time, document count, model, and freshness-check metadata."
  }
]
```

The MCP server is stateless beyond the open Zvec collection. No write tools in v1 — AI assistants can read but not modify the index.

## 8. Performance targets

| Metric | Target | Measured on |
|---|---|---|
| Cold start (`kbx search`) | <2 s | M2 MacBook Air, model already downloaded |
| Cold start, first ever run | <60 s | + model download time on a 50 Mbps connection |
| Ingest throughput, CPU | ≥30 chunks/s | M2 Air, default model |
| Query latency | <100 ms p50, <250 ms p95 | 10k-chunk index, top-k=10 |
| Memory at query time | <500 MB RSS | default model, 10k chunks |
| Index size on disk | <1.5× corpus size | typical markdown |
| Binary size (npm install) | <50 MB before model | excludes model cache |

`kbx doctor --bench` runs these and prints results. Used as a regression test in CI.

## 9. Phasing

### v0.1 — Walking skeleton (1 week)
- `kbx ingest` and `kbx search` only
- Default model hardcoded
- CPU only
- Markdown only, fixed-size chunks

### v0.2 — Production basics (2 weeks)
- CPU embedding benchmark and regression guard
- Heading-aware chunking
- Incremental reindex
- `kbx config`, `kbx stats`, `kbx reset`, `kbx doctor`
- `kbx workspace list`, `kbx workspace forget <selector>`, `kbx workspace delete <selector>`
- `kbx sources list`, `kbx sources remove <selector>`
- `--watch` mode

### v0.3 — Integration (1 week)
- `kbx mcp` server
- Configurable model with safety check on swap

### v0.4 — Polish (1 week)
- `kbx doctor --bench`
- Plain text + source code ingest
- Improved CLI output (colors, progress bars done right)
- Docs site

### v1.0 — Distribution
- Single-binary builds (Node SEA) for users without Node installed
- Homebrew formula
- Signed releases on GitHub

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Transformers.js perf is slower than native Python on CPU | Acceptable: nomic-embed at ~30 chunks/s on CPU is fine for personal-scale corpora. We'll benchmark and document. |
| Zvec Node bindings are newer and less battle-tested than Python | Pin a known-good version; monitor issues; have a thin abstraction layer so we can swap to `vectordb`/LanceDB if needed. |
| GPU acceleration expands support burden | Defer GPU execution providers until after v1; keep v1 CPU-only and benchmarked. |
| First-run model download fails on metered/slow connections | Resumable download via HF cache; allow `kbx model load <path>` for offline install. |
| Users swap models and corrupt their index | Model changes are transactional and require reindex before commit; `manifest.json` still checks model/dimension on every open. |
| Windows ARM / odd platforms not supported by Zvec | v1 ships Linux x64/ARM64 + macOS ARM64 + Windows x64. Document the gap; add as Zvec adds support. |

## 11. Deferred questions

1. **How should `kbx ask` integrate with external AI CLIs?** v1 does not ship answer generation. Reserve `kbx ask` for a later integration with tools like Codex CLI or Claude CLI using the user's existing local subscription. If direct local generation is needed later, plug into Ollama via HTTP as an optional integration.
2. **When should reranking be added?** Reranking is out of v1. Revisit after baseline vector retrieval quality and latency are measured on real workspaces.
3. **Global search across workspaces?** v1 scopes search to the current workspace. Later, `kbx search --global` or a dedicated global command can fan out across the workspace registry and query multiple workspace knowledge bases in parallel.
4. **PDF and DOCX ingest?** Pulls in `pdf-parse` and friends. Probably v1.1 — measure demand first.
5. **Single binary via `bun build --compile`?** Possibly faster route than Node SEA. Test in v0.4.

## 12. Success metrics (post-launch)

- Time from `npm install` to first successful query: median <3 minutes.
- 80% of users on default config never call `kbx config`.
- Crash-free session rate: >99%.
- GitHub: stars and active issues are vanity; the metric that matters is the ratio of "how do I install" issues to "feature request" issues. We want the latter dominating after month 1.

