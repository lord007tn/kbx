# kbx

`kbx` is a zero-service, local-first knowledge base CLI that turns local files into searchable context for AI assistants.

## Language

**kbx**:
A zero-service, local-first knowledge base CLI that is distributed as an npm CLI before v1 and also as standalone binaries at v1.
_Avoid_: Single-binary-only tool before v1

**AI Tool User**:
A developer or technically comfortable user who already uses AI coding or assistant tools and can work with a terminal.
_Avoid_: Non-developer, general consumer

**Knowledge Search**:
A retrieval operation that returns relevant local chunks and citations without synthesizing an answer.
_Avoid_: Ask, answer generation

**Hybrid Retrieval Pipeline**:
A **Knowledge Search** pipeline that indexes chunks into both vector and lexical stores, runs semantic and lexical retrieval in parallel, and merges results before returning cited chunks.
_Avoid_: Vector-only search, lexical-only search

**Lexical Index**:
A local full-text index used for exact terms, symbols, filenames, fuzzy recovery, phrase matching, and BM25-style ranking.
_Avoid_: Live file scan during search

**Retrieval Fusion**:
The deterministic merge step that combines vector and lexical candidates into one ranked result list.
_Avoid_: LLM reranker

**Ask**:
A future command for delegating answer generation to an external AI CLI or subscription-backed assistant.
_Avoid_: Retrieval-only search

**Reranking**:
A post-v1 second-pass retrieval step that reorders vector-search candidates with a separate relevance model.
_Avoid_: v1 retrieval pipeline

**Chat**:
A conversational interface that depends on answer generation and is not part of v1.
_Avoid_: Interactive retrieval loop

**MCP Server**:
A stdio-only local interface that lets AI assistants search **kbx**.
_Avoid_: SSE server, HTTP server

**MCP Read Tool**:
An MCP tool that retrieves knowledge, reports status, or provides guidance without mutating indexed content.
_Avoid_: Hidden side effects

**MCP Maintenance Tool**:
An MCP tool that updates index freshness, refreshes known files, or generates configuration without deleting user data.
_Avoid_: Destructive operation

**Destructive MCP Tool**:
An MCP tool that removes sources, resets indexes, forgets workspaces, or deletes workspace knowledge base data.
_Avoid_: Enabled by default

**MCP Destructive Gate**:
A workspace configuration setting that must explicitly enable **Destructive MCP Tool** registration or execution.
_Avoid_: Agent-controlled deletion without opt-in

**MCP Confirmation Token**:
A structured confirmation string required by a **Destructive MCP Tool** call, usually including the requested operation and workspace identity.
_Avoid_: Boolean confirmation

**Workspace Knowledge Base**:
The `.kbx/` knowledge base attached to the workspace where `kbx` is run.
_Avoid_: Global knowledge base, user-wide collection

**kbx Core**:
The durable local indexing and retrieval layer responsible for ingest, freshness, storage, embeddings, lexical indexes, and citations.
_Avoid_: Agent runtime, platform hooks

**Agent Helper Layer**:
An optional layer on top of **kbx Core** that exposes richer MCP tools, platform adapters, agent guidance, and future hook-based automation.
_Avoid_: Replacing the workspace knowledge base

**Initialized Workspace**:
A workspace that contains a `.kbx/` directory.
_Avoid_: Inferred workspace

**Workspace Root Preference**:
A user setting that controls whether `kbx init` prefers the current directory or a detected git root.
_Avoid_: Silent workspace inference

**Workspace Registry**:
A user-level list of known workspaces that have been initialized or ingested by **kbx**.
_Avoid_: Global collection

**Workspace ID**:
A CUID2 stored in the workspace manifest that identifies a workspace across registry operations.
_Avoid_: Path as identity, name as identity

**Workspace Name**:
A human-readable label for a workspace, usually derived from the workspace directory name.
_Avoid_: Stable identity

**Workspace Selector**:
A user-supplied reference to a workspace by unique name, workspace ID, or path.
_Avoid_: Name-only reference

**Forget Workspace**:
Remove a workspace from the registry while leaving its `.kbx/` directory intact.
_Avoid_: Delete workspace

**Delete Workspace Knowledge Base**:
Delete a workspace's `.kbx/` directory after explicit confirmation.
_Avoid_: Forget workspace

**Reset Workspace Index**:
Clear indexed content for the current workspace while preserving workspace identity, config, and registry entry.
_Avoid_: Delete workspace

**Ingest Policy**:
The rules that decide which files from a path become searchable sources.
_Avoid_: Index everything

**External Import**:
An explicit ingest mode that snapshots files from outside the workspace into `.kbx/imports/` before indexing them.
_Avoid_: Index external path in place

**Session Memory Source**:
An explicit optional source kind that stores compact agent-session summaries or events for later retrieval.
_Avoid_: Hidden full transcript indexing

**Session Memory Retention**:
The policy that decides how long **Session Memory Source** entries remain searchable.
_Avoid_: Permanent session capture by default

**Session Handoff**:
A read-only summary of workspace identity, index state, freshness, recent indexed sources, and explicit retained memory notes for starting or ending agent work.
_Avoid_: Full transcript replay

**Session Event Store**:
A local opt-in append-only SQLite store of agent lifecycle events, tool calls, prompts, bounded outputs, file snapshots, checkpoints, and retention policy.
_Avoid_: Hidden capture through search index chunks

**Session Rewind**:
A preview-first ability to restore workspace files from explicit session file snapshots after exact confirmation.
_Avoid_: Default automatic workspace rollback

**Graph Knowledge**:
A deterministic entity-relation layer extracted from indexed chunks and retained notes with provenance back to chunk IDs.
_Avoid_: Uncited graph facts

**Human Source**:
A user-facing source label shown in local CLI search results.
_Avoid_: Internal import path

**Citation Source**:
A privacy-preserving source label exposed to AI assistants through MCP.
_Avoid_: Absolute external path

**Citation Mode**:
A workspace setting that controls whether MCP citations use safe labels or full paths.
_Avoid_: Always expose full paths

**Supported Platform**:
A v1 runtime platform covered by published Zvec Node bindings.
_Avoid_: Best-effort platform

**Platform Adapter**:
A client-specific integration that generates MCP configuration, validates setup, and provides agent guidance for a supported AI tool.
_Avoid_: Hook adapter by default

**Agent Hook Adapter**:
An optional platform integration that uses host hooks to maintain freshness, capture agent context, or inject guidance during agent sessions.
_Avoid_: Required MCP setup

**Agent Guidance**:
Client-facing instructions that tell an AI assistant when to search, refresh, fetch chunks, cite sources, and avoid unsafe operations.
_Avoid_: Marketing copy

**CPU Embedding**:
The v1 embedding execution mode, using CPU only.
_Avoid_: GPU auto-detection in v1

**Embedding Model Catalog**:
A curated list of supported embedding models with size, benchmark, and quality tradeoff metadata.
_Avoid_: Free-form model string only

**Machine Benchmark Cache**:
A user-level cache of CPU benchmark results for embedding models on the current machine.
_Avoid_: Per-workspace speed benchmark

**Model Switch Reindex**:
A rebuild of the current workspace index required when changing embedding models.
_Avoid_: Model change without rebuild

**Ingest Source Manifest**:
A workspace record of the roots and import snapshots that should be used when rebuilding the index.
_Avoid_: Implicit full-workspace rebuild

**Source Removal**:
Removal of an ingest source from the manifest and its indexed chunks.
_Avoid_: Manual manifest edit

**Index Freshness**:
Whether the current index reflects the latest filesystem state.
_Avoid_: Implicit search refresh

**Freshness Refresh**:
A bounded update that detects changed or removed indexed files and updates the local index before or during retrieval.
_Avoid_: Full workspace reindex

**Opportunistic MCP Freshness**:
A small-budget **Freshness Refresh** performed by MCP search tools so AI assistants are less likely to use stale context.
_Avoid_: Blocking MCP search on an unbounded filesystem scan

**Stored Stats**:
Cheap workspace metadata recorded during ingest and index operations.
_Avoid_: Default filesystem scan

**Doctor Check**:
A layered diagnostic that runs moderate workspace health checks by default and expensive checks only by flag.
_Avoid_: Always deep diagnostics

**Watch Ingest**:
A long-running ingest mode that refreshes indexed chunks for manifest sources or the provided ingest target.
_Avoid_: Watching external originals

**Hot Index Watcher**:
A long-running process that keeps indexed workspace sources current by applying file-level reindex and delete updates as filesystem events arrive.
_Avoid_: Rebuilding the entire workspace for every change

**Global Workspace Search**:
A future search mode that queries multiple registered **Workspace Knowledge Bases** in parallel.
_Avoid_: Merged global index

## Relationships

- **kbx** indexes local files into a local knowledge base.
- **kbx** serves retrieved context to AI assistants through MCP.
- **kbx Core** owns the local workspace index and retrieval behavior.
- The **Agent Helper Layer** builds on **kbx Core** and must not be required for basic CLI search.
- The **Agent Helper Layer** includes expanded MCP tools, platform adapters, agent guidance, and future hook-based automation.
- An **AI Tool User** uses **kbx** to make local files searchable by their AI assistant.
- **Knowledge Search** retrieves chunks from **kbx**.
- The **Hybrid Retrieval Pipeline** is the default direction for **Knowledge Search**.
- The **Hybrid Retrieval Pipeline** uses vector retrieval for semantic similarity and the **Lexical Index** for exact, symbolic, phrase, and typo-tolerant lookup.
- **Retrieval Fusion** combines vector and lexical candidates before final result trimming.
- **Ask** depends on **Knowledge Search** and an external AI assistant.
- **Reranking** is outside the v1 **Knowledge Search** pipeline.
- **Chat** depends on answer generation and is outside the v1 retrieval-only scope.
- The **MCP Server** exposes **Knowledge Search** to AI assistants without opening a network server.
- **MCP Read Tool** calls are safe to expose by default.
- **MCP Maintenance Tool** calls may mutate the index to improve freshness but must not delete user data.
- **Destructive MCP Tool** calls are disabled unless the **MCP Destructive Gate** is explicitly enabled.
- A **Destructive MCP Tool** also requires an **MCP Confirmation Token** so accidental model calls fail closed.
- **Knowledge Search** queries the current **Workspace Knowledge Base**.
- Each workspace has its own **Workspace Knowledge Base**.
- The **Workspace Registry** records known workspaces without owning their indexed content.
- **Global Workspace Search** fans out to registered **Workspace Knowledge Bases**.
- `kbx init` creates the current **Workspace Knowledge Base**, registers the workspace, and ignores `.kbx/` in git when applicable.
- Commands use the nearest ancestor **Initialized Workspace**; if none exists, the user must run `kbx init`.
- **Workspace Root Preference** affects where `kbx init` creates `.kbx/`, not how existing workspaces are discovered.
- `kbx ingest` may prompt to initialize an **Initialized Workspace** when none exists, but it must not silently create one.
- A **Workspace ID** is the stable identity; a **Workspace Name** and path are display fields.
- A **Workspace Selector** resolves by ID or path unambiguously; names are allowed only when unique.
- **Forget Workspace** changes only the **Workspace Registry**.
- **Delete Workspace Knowledge Base** removes local index data and requires confirmation.
- **Reset Workspace Index** clears indexed content without removing the **Workspace Knowledge Base**.
- **Ingest Policy** uses an allowlist, built-in excludes, and gitignore rules by default.
- `kbx ingest` without a path ingests the current initialized workspace root; a path narrows the ingest scope.
- **External Import** requires `--allow-external` and copies outside files into `.kbx/imports/` before indexing.
- `.kbx/imports/` is the only indexable area inside `.kbx/`.
- **External Import** does not sync later changes from the original external path.
- Re-running **External Import** for the same absolute source path replaces that source's snapshot.
- **Session Memory Source** is optional and separate from workspace files and **External Import** content.
- **Session Memory Source** stores compact session memory, not complete hidden transcripts.
- **Session Memory Retention** must be explicit before session memory is enabled by default.
- **Session Handoff** summarizes current workspace/index state and retained memory note metadata without reading hidden transcripts.
- **Session Event Store** is required before **Session Rewind** can exist.
- **Session Rewind** has a read-only replay level and a higher-risk workspace restore level; workspace restore requires explicit snapshots or VCS-backed patches.
- **Graph Knowledge** depends on stable provenance back to chunks, retained memory notes, or session events.
- **Human Source** is used in local CLI output; **Citation Source** is used in MCP citations.
- **Citation Source** hides absolute external paths by default.
- **Citation Mode** defaults to safe and can be changed to full-path when MCP clients need precise paths.
- The Zvec-backed chunk store uses SQL-like filter syntax, including `source = '<path>'` for source deletion.
- v1 **Supported Platform** means macOS Apple Silicon, Linux x64/ARM64, or Windows x64.
- A **Platform Adapter** is the first level of AI client support and does not require hook capability.
- An **Agent Hook Adapter** is added only for platforms with stable hook behavior and remains optional.
- **Agent Guidance** is part of the **Agent Helper Layer** and can be delivered through MCP prompts/resources or client-specific instruction files.
- v1 uses **CPU Embedding** only; GPU acceleration is deferred.
- Users choose models from the **Embedding Model Catalog**, which shows size and benchmark tradeoffs.
- Benchmarking the whole **Embedding Model Catalog** requires explicit `--all` confirmation.
- **Machine Benchmark Cache** stores model speed and load metrics; each workspace stores only its selected model.
- **Model Switch Reindex** is required before a model change is committed.
- **Ingest Source Manifest** is the source of truth for reindexing.
- **Ingest Source Manifest** normalizes overlapping workspace roots so broader roots replace covered child roots.
- Ingesting a child path already covered by a broader root refreshes that path without narrowing the **Ingest Source Manifest**.
- **Source Removal** is done through `kbx sources remove`, updates the live index immediately, and refuses covered child paths.
- CLI **Knowledge Search** reads the current index by default and performs a **Freshness Refresh** only when requested.
- MCP **Knowledge Search** may perform **Opportunistic MCP Freshness** within a bounded time budget before returning results.
- **Freshness Refresh** updates changed files and deletes removed files from both vector and lexical stores.
- `kbx stats` shows **Stored Stats** by default; freshness scanning is explicit.
- **Doctor Check** defaults to structural health checks; freshness and benchmark checks require flags.
- **Watch Ingest** watches current workspace sources only and does not watch original external paths.
- The **Hot Index Watcher** is the preferred way to keep an index current during active agent sessions.

## Example dialogue

> **Dev:** "Can we call **kbx** a single binary in the first npm-only release?"
> **Domain expert:** "No. **kbx** is npm/npx-first; standalone binaries and platform archives are out of scope."
>
> **Dev:** "Is the product still called `kb`?"
> **Domain expert:** "No. The product, npm package, CLI binary, workspace directory, and MCP tool prefix use **kbx**."
>
> **Dev:** "Are we optimizing setup for someone who has never used a terminal?"
> **Domain expert:** "No. The v1 user is an **AI Tool User** who is comfortable with developer-style setup."
>
> **Dev:** "Should `kbx ask` return generated answers?"
> **Domain expert:** "No. **Ask** is not part of the product; **kbx** remains retrieval-only."
>
> **Dev:** "Should `kbx chat` ship in v1?"
> **Domain expert:** "No. **Chat** depends on answer generation, while v1 is retrieval-only."
>
> **Dev:** "Should v1 rerank search results?"
> **Domain expert:** "Do **Retrieval Fusion** now, not model-based **Reranking**. The default direction is the **Hybrid Retrieval Pipeline** with vector and lexical candidates merged deterministically."
>
> **Dev:** "Should v1 support MCP over SSE?"
> **Domain expert:** "No. The **MCP Server** is stdio-only in v1."
>
> **Dev:** "Does `kbx search` search everything this user ever indexed?"
> **Domain expert:** "No. `kbx search` searches the current **Workspace Knowledge Base** only."
>
> **Dev:** "How can a user search workspaces from outside a project later?"
> **Domain expert:** "Use **Global Workspace Search** over the **Workspace Registry**, querying each workspace knowledge base in parallel."
>
> **Dev:** "Where does the workspace index live?"
> **Domain expert:** "Inside the workspace at `.kbx/`; `kbx init` adds `.kbx/` to `.gitignore` when it detects a git repo."
>
> **Dev:** "Can users list registered workspaces in v1?"
> **Domain expert:** "Yes. v1 includes listing and removing entries from the **Workspace Registry**, but not **Global Workspace Search**."
>
> **Dev:** "If I run `kbx search` from `project-a/packages/api/src`, which index is used?"
> **Domain expert:** "The nearest ancestor **Initialized Workspace**, such as `project-a/.kbx/`. If no `.kbx/` exists above the current directory, the command tells the user to run `kbx init`."
>
> **Dev:** "If I run `kbx init` from a subdirectory of a git repo, where is `.kbx/` created?"
> **Domain expert:** "By default it proposes the current directory and detects the git root. A configurable **Workspace Root Preference** can make git root the default, and the user can opt out."
>
> **Dev:** "Can `kbx ingest` create a workspace on first run?"
> **Domain expert:** "Only after prompting. It can continue ingest after the user initializes a workspace, but it must not silently create `.kbx/`."
>
> **Dev:** "Should users identify workspaces by path or generated ID?"
> **Domain expert:** "The stable identity is a CUID2 **Workspace ID**, but `kbx workspace list` displays a human-readable **Workspace Name** and path."
>
> **Dev:** "Can two workspaces both be named `app`?"
> **Domain expert:** "Yes. **Workspace Name** is display-only; a **Workspace Selector** must use ID or path when a name is ambiguous."
>
> **Dev:** "Does removing a workspace delete its `.kbx/` data?"
> **Domain expert:** "No. **Forget Workspace** removes only the registry entry. **Delete Workspace Knowledge Base** is a separate confirmed destructive action."
>
> **Dev:** "What is the difference between `kbx reset` and `kbx workspace delete`?"
> **Domain expert:** "`kbx reset` clears the current workspace index but keeps identity and config. `kbx workspace delete` removes the selected `.kbx/` directory after confirmation."
>
> **Dev:** "Should `kbx ingest .` index every file under the workspace?"
> **Domain expert:** "No. The **Ingest Policy** includes text-like files, respects gitignore, and excludes dependency, build, VCS, and `.kbx/` directories."
>
> **Dev:** "What does `kbx ingest` do without a path?"
> **Domain expert:** "It ingests the current initialized workspace root. Pass a path only to narrow the ingest scope."
>
> **Dev:** "Can `kbx ingest ~/notes` index files outside the current workspace?"
> **Domain expert:** "Not by default. With `--allow-external`, it performs an **External Import** by copying those files into `.kbx/imports/` before indexing."
>
> **Dev:** "Does the default `.kbx/` exclude also skip imported files?"
> **Domain expert:** "No. `.kbx/imports/` is managed user content and is the only indexable area inside `.kbx/`."
>
> **Dev:** "If the original external file changes, does `kbx ingest` update the imported copy?"
> **Domain expert:** "No. **External Import** is a snapshot. Re-run with `--allow-external` to import a new copy."
>
> **Dev:** "If I import the same external folder twice, do I get duplicates?"
> **Domain expert:** "No. The snapshot lives under a hash of the original absolute path and is replaced on re-import."
>
> **Dev:** "Should search results show `.kbx/imports/<hash>/files/foo.md`?"
> **Domain expert:** "No. Search results and citations use a **Human Source** such as the workspace-relative path or original external path."
>
> **Dev:** "Should MCP citations reveal `/Users/alice/client-x/notes/foo.md`?"
> **Domain expert:** "No. MCP uses a privacy-preserving **Citation Source** for external imports."
>
> **Dev:** "Can an MCP client opt into full file paths?"
> **Domain expert:** "Yes. Set **Citation Mode** to `full-path`; the default remains `safe`."
>
> **Dev:** "Does v1 support macOS Intel or Windows ARM?"
> **Domain expert:** "No. v1 **Supported Platform** follows published Zvec bindings: macOS Apple Silicon, Linux x64/ARM64, and Windows x64."
>
> **Dev:** "Does v1 auto-detect and use GPU acceleration?"
> **Domain expert:** "No. v1 uses **CPU Embedding** only; GPU execution providers are later work."
>
> **Dev:** "Should users type any Hugging Face model name into config?"
> **Domain expert:** "No. v1 exposes an **Embedding Model Catalog** with supported models, sizes, and CPU benchmark tradeoffs."
>
> **Dev:** "Should `kbx model benchmark` download every model?"
> **Domain expert:** "No. It benchmarks the current model by default. Use `--all` explicitly to benchmark the full **Embedding Model Catalog**."
>
> **Dev:** "Are benchmark results workspace-specific?"
> **Domain expert:** "No. CPU speed is machine-level, so store it in the **Machine Benchmark Cache**. Model selection remains workspace-specific."
>
> **Dev:** "Can `kbx model use minilm` change config but leave the old index in place?"
> **Domain expert:** "No. It offers a **Model Switch Reindex**. If the user declines, nothing changes."
>
> **Dev:** "When a model switch reindexes, does it scan the whole workspace?"
> **Domain expert:** "No. It rebuilds from the **Ingest Source Manifest**."
>
> **Dev:** "If `docs` was indexed and then the user runs `kbx ingest`, do both roots stay?"
> **Domain expert:** "No. The workspace root covers `docs`, so the **Ingest Source Manifest** keeps only the broader root."
>
> **Dev:** "If the whole workspace was indexed and then the user runs `kbx ingest docs`, does the corpus narrow to docs?"
> **Domain expert:** "No. It refreshes `docs`; the broader workspace root remains in the **Ingest Source Manifest**."
>
> **Dev:** "How does a user stop indexing a source?"
> **Domain expert:** "Use **Source Removal** through `kbx sources remove`; it updates the manifest and removes indexed chunks immediately."
>
> **Dev:** "Does `kbx search` check the filesystem before every query?"
> **Domain expert:** "No for default CLI search. Use `kbx search --fresh` or the **Hot Index Watcher** when current filesystem state matters."
>
> **Dev:** "Can MCP tools refresh or reindex stale content?"
> **Domain expert:** "Yes, through bounded **MCP Maintenance Tool** calls. **Destructive MCP Tool** calls stay disabled unless the **MCP Destructive Gate** and **MCP Confirmation Token** are present."
>
> **Dev:** "Does `kbx stats` scan the workspace?"
> **Domain expert:** "No. It shows **Stored Stats** by default. Use an explicit freshness check for filesystem scanning."
>
> **Dev:** "Does `kbx doctor` benchmark and scan by default?"
> **Domain expert:** "No. **Doctor Check** is layered: default is moderate, while `--fresh`, `--bench`, and `--deep` run expensive checks."
>
> **Dev:** "Does `kbx ingest --watch` watch original external paths?"
> **Domain expert:** "No. **Watch Ingest** watches manifest sources inside the workspace, including `.kbx/imports/` snapshots, but not original external locations."

## Flagged ambiguities

- "single-binary" was used alongside npm-first distribution. Resolved: **kbx** is npm/npx-first, and standalone binaries/platform archives are out of scope.
- "`kb`" was unavailable and too generic as a package identity. Resolved: the product name is **kbx**.
- "non-developer" overstated the v1 audience. Resolved: the v1 audience is **AI Tool Users**.
- "`ask`" implied built-in answer generation. Resolved: **Ask** is a permanent non-goal; use **Knowledge Search** through `kbx search`.
- "`chat`" implied answer generation or a confusing search REPL. Resolved: **Chat** is a permanent non-goal.
- "retrieval enhancement" mixed deterministic fusion with model-based reranking. Resolved: **Retrieval Fusion** is part of the **Hybrid Retrieval Pipeline**, while model-based **Reranking** remains later work.
- "`mcp --sse`" conflicted with the zero-service local promise. Resolved: the v1 **MCP Server** is stdio-only.
- "default collection" implied a user-global corpus. Resolved: v1 uses a **Workspace Knowledge Base** attached to the workspace where `kbx` is run.
- "global search" does not mean a single global index. Resolved: **Global Workspace Search** is a future fan-out over the **Workspace Registry**.
- "attached to workspace" needed a physical storage rule. Resolved: a **Workspace Knowledge Base** lives in `<workspace>/.kbx/`.
- The **Workspace Registry** is user-facing in v1 for listing and removal, but **Global Workspace Search** remains post-v1.
- "workspace" is not inferred from git alone. Resolved: a workspace is initialized by `.kbx/`; commands fail with an init prompt when no ancestor `.kbx/` exists.
- `kbx init` may detect a git root, but it must not silently create `.kbx/` somewhere surprising. Resolved: `kbx init` prompts when a git root differs from the current directory and follows the user's **Workspace Root Preference**.
- First ingest may prompt for initialization. Resolved: `kbx ingest` can initialize only through an explicit prompt or non-interactive flag.
- CUID2 IDs are not human-friendly. Resolved: use a CUID2 **Workspace ID** for stable identity and show **Workspace Name** plus path for humans.
- **Workspace Name** may collide. Resolved: names are valid selectors only when unique; ID and path remain authoritative.
- "remove workspace" was ambiguous. Resolved: use **Forget Workspace** for registry-only removal and **Delete Workspace Knowledge Base** for confirmed deletion.
- "`reset`" and "`workspace delete`" overlapped. Resolved: **Reset Workspace Index** preserves workspace identity and config; **Delete Workspace Knowledge Base** removes `.kbx/`.
- "code ingest" could imply indexing every repository file. Resolved: **Ingest Policy** defaults to an allowlist plus gitignore and built-in excludes.
- `kbx ingest <path>` made path selection feel mandatory. Resolved: `kbx ingest` defaults to the current workspace root, and `[path]` is optional.
- External paths would weaken workspace ownership. Resolved: outside paths require **External Import** through `--allow-external`, which copies files into `.kbx/imports/` before indexing.
- `.kbx/` is generally excluded, but imported user content needs to be searchable. Resolved: `.kbx/imports/` is the only indexable area inside `.kbx/`.
- External import sync would keep hidden dependencies outside the workspace. Resolved: **External Import** is a snapshot in v1.
- Repeated external imports could duplicate content. Resolved: store each **External Import** under an absolute-source-path hash and replace it on re-import.
- Internal import paths are not human-readable. Resolved: local CLI output uses **Human Source** labels and MCP uses **Citation Source** labels.
- Absolute external paths can leak sensitive context to AI assistants. Resolved: MCP uses **Citation Source** labels that hide absolute external paths by default.
- Some MCP clients need openable paths. Resolved: **Citation Mode** defaults to `safe` and supports explicit `full-path` opt-in.
- Zvec filter syntax was assumed to be JavaScript-like. Resolved: source filters use SQL-like `=`.
- Platform support must match native dependencies. Resolved: macOS Intel and Windows ARM are unsupported in v1.
- GPU auto-detection was too broad for v1. Resolved: v1 uses **CPU Embedding** only.
- Model choice needs visible tradeoffs. Resolved: use an **Embedding Model Catalog** rather than a bare model string.
- Benchmarking every model can cause large downloads. Resolved: benchmark the current model by default; full catalog benchmarking requires explicit `--all`.
- CPU benchmark results were scoped too narrowly. Resolved: store them in a **Machine Benchmark Cache**, while each workspace keeps its selected model.
- Changing embedding models without rebuilding leaves an unusable index. Resolved: model switches are transactional and require **Model Switch Reindex**.
- Reindexing needs a stable source list. Resolved: keep an **Ingest Source Manifest** and rebuild from it.
- Overlapping ingest roots could double-index files. Resolved: normalize **Ingest Source Manifest** roots so broader roots replace covered child roots.
- A child ingest under an existing broad root could be misread as narrowing. Resolved: it is a targeted refresh only.
- Users need to inspect and change indexed roots. Resolved: v1 includes `kbx sources list` and **Source Removal** with `kbx sources remove`.
- Source removal should affect current search results. Resolved: **Source Removal** deletes matching chunks from the live index immediately.
- Search-time freshness scans would slow normal CLI queries. Resolved: CLI **Knowledge Search** stays fast by default and refreshes only through `--fresh` or the **Hot Index Watcher**.
- MCP agents need fresher context than manual CLI search. Resolved: MCP search may perform **Opportunistic MCP Freshness** within a bounded budget.
- MCP write access could surprise users. Resolved: split **MCP Read Tool**, **MCP Maintenance Tool**, and **Destructive MCP Tool** surfaces; destructive operations require explicit gate and confirmation token.
- Stats should stay fast. Resolved: `kbx stats` shows **Stored Stats** by default.
- Doctor should be useful without becoming slow. Resolved: **Doctor Check** runs expensive freshness and benchmark work only by flag.
- Watch mode needed tight scope. Resolved: **Watch Ingest** watches workspace-contained sources only.

