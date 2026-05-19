#!/usr/bin/env node
import { confirm, isCancel, select } from "@clack/prompts";
import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KBX_AGENT_GUIDE } from "./agent-guide";
import { getConfigValue, getUserConfigValue, listConfigValues, listUserConfigValues, setConfigValue, setUserConfigValue } from "./config";
import { buildWorkspaceContext, formatWorkspaceContextMarkdown } from "./context";
import { addDevReport, listDevReports } from "./dev-report";
import { benchmarkLine, freshnessLine, runDoctor } from "./doctor";
import { directorySizeBytes, formatBytes } from "./io";
import { ingestSource, ingestWorkspaceTarget, loadIndexStats, rebuildWorkspaceIndexForModel, refreshWorkspaceFreshness, refreshWorkspaceIndex, removeSource, resetWorkspaceIndex, resolveSourceEntry, scanWorkspaceFreshness, type IngestProgressEvent, type IngestResult } from "./indexer";
import { buildFileContext, buildMemoryHistory, buildMemoryVerification, buildWorkspaceInspection } from "./inspection";
import { runMcpServer } from "./mcp";
import { cachedModelBenchmark, formatBenchmarkSpeed, isCatalogModelInstalled, loadCatalogModelFromPath, MODEL_CATALOG, modelDetails, resolveModel, type ModelCatalogEntry } from "./models";
import { searchRegisteredWorkspaces, searchWorkspace } from "./search";
import { evaluateRetrieval, parseRetrievalEvalCorpus } from "./retrieval-eval";
import { buildGraph, graphStats, queryGraph } from "./graph-store";
import { addSessionMemory, listSessionMemories, pruneExpiredSessionMemories, sessionMemorySource } from "./session-memory";
import {
  addSessionCheckpoint,
  appendSessionEvent,
  applySessionRewind,
  endSession,
  getSession,
  listSessionEvents,
  listSessions,
  previewSessionRewind,
  pruneSessions,
  sessionTimeline,
  startSession,
  type SessionEventType
} from "./session-store";
import { KBX_VERSION } from "./version";
import { startBackgroundWatch, stopBackgroundWatch, watchIngest, watchStatus } from "./watch";
import { generateAdapterConfig, generateAdapterHooks, listAdapters } from "./adapters";
import { handleClaudeCodePostToolUse, handleFileRefreshHook, handleSessionCaptureHook } from "./hooks";
import { createTerminalProgress } from "./terminal-ui";
import {
  deleteWorkspaceKnowledgeBase,
  findGitRoot,
  findWorkspace,
  forgetWorkspace,
  initWorkspace,
  loadConfig,
  loadUserConfig,
  loadManifest,
  loadRegistry,
  loadSources,
  registryPath,
  saveConfig,
  saveUserConfig,
  saveManifest,
  workspaceFromRoot
} from "./workspace";
import { ChunkVectorStore } from "./vector-store";

const program = new Command();

program
  .name("kbx")
  .description("Local-first knowledge base CLI for searchable AI context.")
  .summary("Index a workspace into .kbx/ and retrieve local chunks for AI assistants.")
  .version(KBX_VERSION)
  .showHelpAfterError()
  .addHelpText("after", `

Common workflows:
  $ kbx init --model nomic
  $ kbx ingest
  $ kbx search "workspace registry" -k 5
  $ kbx memory add "Decision: keep v1 retrieval-only." --retention-days 30
  $ kbx mcp

Privacy model:
  kbx stores workspace data under .kbx/ and does not generate answers.
  Search and MCP retrieve local chunks; your AI assistant decides how to use them.
`);

program
  .command("init")
  .description("Create .kbx/ for the current workspace.")
  .summary("Initialize workspace metadata, config, sources, and model selection.")
  .argument("[path]", "workspace root", ".")
  .option("--here", "initialize the current directory")
  .option("--git-root", "initialize the nearest git root")
  .option("--model <model-id>", "embedding model to use for this workspace")
  .option("--choose-model", "choose an embedding model interactively")
  .addHelpText("after", `

Examples:
  $ kbx init
  $ kbx init --here --model minilm
  $ kbx init --git-root --model nomic

Model IDs:
  minilm      fastest and smallest
  nomic       default balanced model
  bge-base    English quality candidate
  qwen3-0.6b  larger quality candidate
`)
  .action(async (targetPath: string, options: { here?: boolean; gitRoot?: boolean; model?: string; chooseModel?: boolean }) => {
    const root = await resolveInitRoot(targetPath, options);
    const model = await resolveRequestedModel(options.model, { interactive: options.chooseModel === true });
    const workspace = await initWorkspace(root, model ? { model: model.model, dim: model.dim } : {});
    const manifest = await loadManifest(workspace);
    console.log(`Initialized ${manifest.name} (${manifest.workspace_id.slice(0, 8)})`);
    console.log(`Model: ${modelLabel(manifest.model)} (${manifest.dim}d)`);
    console.log(workspace.kbxDir);
  });

program
  .command("setup")
  .description("Run first-time workspace setup.")
  .summary("Initialize, choose a model, ingest the workspace, and print an MCP config snippet.")
  .argument("[path]", "workspace root", ".")
  .option("--here", "initialize the current directory")
  .option("--git-root", "initialize the nearest git root")
  .option("--model <model-id>", "embedding model to use for this workspace")
  .option("--choose-model", "choose an embedding model interactively")
  .option("--skip-ingest", "initialize and print config without indexing files")
  .option("--client <client>", "MCP client adapter to print", "codex")
  .option("--command <command>", "command to use in generated MCP config", "kbx")
  .addHelpText("after", `

Examples:
  $ kbx setup --model minilm
  $ kbx setup --git-root --client claude-code
  $ kbx setup --skip-ingest --client cursor
`)
  .action(async (
    targetPath: string,
    options: {
      here?: boolean;
      gitRoot?: boolean;
      model?: string;
      chooseModel?: boolean;
      skipIngest?: boolean;
      client: string;
      command: string;
    }
  ) => {
    const root = await resolveInitRoot(targetPath, options);
    const model = await resolveRequestedModel(options.model, {
      interactive: options.chooseModel === true || (!options.model && process.stdin.isTTY === true)
    });
    const workspace = await initWorkspace(root, model ? { model: model.model, dim: model.dim } : {});
    const manifest = await loadManifest(workspace);

    console.log(`Workspace: ${manifest.name} (${manifest.workspace_id.slice(0, 8)})`);
    console.log(`Root: ${workspace.root}`);
    console.log(`Model: ${modelLabel(manifest.model)} (${manifest.dim}d)`);

    if (options.skipIngest === true) {
      console.log("Ingest: skipped");
    } else {
      const ingestProgress = createIngestProgress();
      let result: IngestResult;
      try {
        result = await ingestWorkspaceTarget(workspace, workspace.root, {
          onProgress: ingestProgress?.onProgress
        });
      } catch (error) {
        ingestProgress?.error();
        throw error;
      } finally {
        await ingestProgress?.stop();
      }
      console.log(`Ingest: indexed ${result.files} file(s), ${result.chunks} new chunk(s), ${result.skipped} skipped/unchanged, ${result.deleted} deleted.`);
    }

    const snippet = generateAdapterConfig(options.client, {
      command: options.command,
      args: ["mcp"]
    });
    console.log(`MCP config for ${snippet.clientName} (${snippet.configPath}):`);
    console.log(snippet.content.trimEnd());
    for (const note of snippet.notes) {
      console.log(`# ${note}`);
    }
  });

program
  .command("ingest")
  .description("Index text-like files in this workspace.")
  .summary("Refresh the current workspace index from workspace or external sources.")
  .argument("[path]", "workspace path to ingest", ".")
  .option("--watch", "watch sources and refresh changed files")
  .option("--allow-external", "snapshot and index a path outside the workspace")
  .option("--include <glob>", "only ingest files matching this gitignore-style glob", collectOption, [])
  .option("--exclude <glob>", "skip files matching this gitignore-style glob", collectOption, [])
  .option("--no-gitignore", "do not apply .gitignore rules")
  .addHelpText("after", `

Examples:
  $ kbx ingest
  $ kbx ingest docs --include "**/*.md" --exclude "drafts/**"
  $ kbx ingest C:\\Users\\you\\notes --allow-external
  $ kbx ingest --watch

Notes:
  External paths require --allow-external and are copied into .kbx/imports/.
  Search does not auto-refresh; rerun ingest or use --watch while editing.
`)
  .action(async (
    targetPath: string,
    options: { watch?: boolean; allowExternal?: boolean; include: string[]; exclude: string[]; gitignore?: boolean }
  ) => {
    const workspace = await findWorkspace(process.cwd()) ?? await maybeInitWorkspace();
    if (!workspace) {
      throw new Error("No kbx workspace found. Run kbx init first.");
    }

    const absoluteTarget = path.resolve(targetPath);
    const ingestProgress = createIngestProgress();
    let result: IngestResult;
    try {
      result = await ingestWorkspaceTarget(workspace, absoluteTarget, {
        allowExternal: options.allowExternal,
        include: options.include,
        exclude: options.exclude,
        noGitignore: options.gitignore === false,
        onProgress: ingestProgress?.onProgress
      });
    } catch (error) {
      ingestProgress?.error();
      throw error;
    } finally {
      await ingestProgress?.stop();
    }
    console.log(`Indexed ${result.files} file(s), ${result.chunks} new chunk(s), ${result.skipped} skipped/unchanged file(s), ${result.deleted} deleted file(s).`);

    if (options.watch === true) {
      await watchIngest(workspace, absoluteTarget);
    } else {
      await maybeStartConfiguredWatch(workspace);
    }
  });

program
  .command("search")
  .description("Retrieve top chunks from the current workspace.")
  .summary("Run semantic retrieval against the nearest initialized workspace.")
  .argument("<query>", "search query")
  .option("-k, --top-k <number>", "number of chunks to return", parsePositiveInteger, 5)
  .option("--fresh", "refresh changed, deleted, or new source files before searching")
  .option("--global", "search across all registered workspaces")
  .option("--graph", "include graph-expanded candidates when a graph has been built")
  .option("--json", "output structured JSON with chunk IDs")
  .option("--include-superseded-memories", "include retained notes that have been superseded")
  .option("--reranker <mode>", "optional reranker mode: none, local, model, or command", "none")
  .option("--reranker-model <model>", "Transformers.js feature-extraction model for --reranker model")
  .option("--reranker-command <command>", "external reranker command that reads JSON from stdin and writes scores JSON")
  .addHelpText("after", `

Examples:
  $ kbx search "deployment notes"
  $ kbx search "workspace registry" -k 10
  $ kbx search "new ADR" --fresh
  $ kbx search "session timeout" --global
  $ kbx search "supporting decision" --json
  $ kbx search "auth timeout" --reranker model
  $ kbx search "auth timeout" --reranker command --reranker-command "node rerank.mjs"

Search reads the existing index by default. Use --fresh to refresh sources before querying.
Model or LLM reranking is optional and off by default.
`)
  .action(async (query: string, options: { topK: number; fresh?: boolean; global?: boolean; graph?: boolean; json?: boolean; includeSupersededMemories?: boolean; reranker: "none" | "local" | "model" | "command"; rerankerModel?: string; rerankerCommand?: string }) => {
    if (options.global === true) {
      const hits = await searchRegisteredWorkspaces(query, options.topK, {
        includeSupersededMemories: options.includeSupersededMemories === true,
        reranker: {
          mode: options.reranker,
          model: options.rerankerModel,
          command: options.rerankerCommand
        }
      });
      if (options.json === true) {
        console.log(JSON.stringify({
          query,
          global: true,
          results: hits.map((hit) => ({
            id: hit.id,
            workspace: hit.workspace,
            local_source: hit.local_source,
            source: hit.source,
            citation_source: hit.citation_source,
            chunk_idx: hit.chunk_idx,
            score: hit.score,
            match: hit.match,
            preview: excerpt(hit.snippet ?? hit.text)
          }))
        }, null, 2));
        return;
      }
      if (hits.length === 0) {
        console.log("No results.");
        return;
      }

      for (const [index, hit] of hits.entries()) {
        console.log(`${index + 1}. [${hit.workspace.name}] ${hit.local_source}#${hit.chunk_idx} (${hit.score.toFixed(3)})`);
        console.log(indent(excerpt(hit.snippet ?? hit.text)));
        console.log("");
      }
      return;
    }

    const workspace = await findWorkspace(process.cwd());
    if (!workspace) {
      throw new Error("No kbx workspace found. Run kbx init first.");
    }
    await maybeStartConfiguredWatch(workspace);

    if (options.fresh === true) {
      const refreshProgress = createIngestProgress();
      let freshness: Awaited<ReturnType<typeof refreshWorkspaceFreshness>>;
      try {
        freshness = await refreshWorkspaceFreshness(workspace, {
          onProgress: refreshProgress?.onProgress
        });
      } catch (error) {
        refreshProgress?.error();
        throw error;
      } finally {
        await refreshProgress?.stop();
      }
      if (freshness.refreshed && freshness.refresh) {
        console.error(`Refreshed ${freshness.refresh.files} file(s), ${freshness.refresh.chunks} new chunk(s), ${freshness.refresh.skipped} skipped/unchanged, ${freshness.refresh.deleted} deleted.`);
      }
    }

    const hits = await searchWorkspace(workspace, query, options.topK, {
      includeSupersededMemories: options.includeSupersededMemories === true,
      graph: {
        enabled: options.graph === true
      },
      reranker: {
        mode: options.reranker,
        model: options.rerankerModel,
        command: options.rerankerCommand
      }
    });
    if (options.json === true) {
      console.log(JSON.stringify({
        query,
        results: hits.map((hit) => ({
          id: hit.id,
          source: hit.source,
          citation_source: hit.citation_source,
          chunk_idx: hit.chunk_idx,
          score: hit.score,
          match: hit.match,
          ...(hit.branch_name ? { branch: hit.branch_name } : {}),
          preview: excerpt(hit.snippet ?? hit.text)
        }))
      }, null, 2));
      return;
    }
    if (hits.length === 0) {
      console.log("No results.");
      return;
    }

    for (const [index, hit] of hits.entries()) {
      console.log(`${index + 1}. ${hit.source}#${hit.chunk_idx} (${hit.score.toFixed(3)})`);
      console.log(indent(excerpt(hit.snippet ?? hit.text)));
      console.log("");
    }
  });

program
  .command("context")
  .description("Build a bounded markdown context bundle from search results.")
  .summary("Search, group, and print full cited chunks for AI task context.")
  .argument("<query>", "search query")
  .option("-k, --top-k <number>", "number of chunks to include", parsePositiveInteger, 8)
  .option("--max-chars <number>", "maximum markdown output characters", parsePositiveInteger, 16000)
  .option("--fresh", "refresh changed, deleted, or new source files before building context")
  .option("--json", "output structured JSON instead of markdown")
  .option("--reranker <mode>", "optional reranker mode: none, local, model, or command", "none")
  .option("--reranker-model <model>", "Transformers.js feature-extraction model for --reranker model")
  .option("--reranker-command <command>", "external reranker command that reads JSON from stdin and writes scores JSON")
  .addHelpText("after", `

Examples:
  $ kbx context "release workflow"
  $ kbx context "auth timeout" -k 12 --max-chars 24000
  $ kbx context "edited file behavior" --fresh
`)
  .action(async (
    query: string,
    options: {
      topK: number;
      maxChars: number;
      fresh?: boolean;
      json?: boolean;
      reranker: "none" | "local" | "model" | "command";
      rerankerModel?: string;
      rerankerCommand?: string;
    }
  ) => {
    const workspace = await requireWorkspace();
    await maybeStartConfiguredWatch(workspace);

    if (options.fresh === true) {
      const refreshProgress = createIngestProgress();
      try {
        await refreshWorkspaceFreshness(workspace, {
          onProgress: refreshProgress?.onProgress
        });
      } catch (error) {
        refreshProgress?.error();
        throw error;
      } finally {
        await refreshProgress?.stop();
      }
    }

    const context = await buildWorkspaceContext(workspace, query, {
      topK: options.topK,
      maxChars: options.maxChars,
      citationMode: "full-path",
      reranker: {
        mode: options.reranker,
        model: options.rerankerModel,
        command: options.rerankerCommand
      }
    });

    if (options.json === true) {
      console.log(JSON.stringify(context, null, 2));
      return;
    }

    console.log(formatWorkspaceContextMarkdown(context));
  });

program
  .command("file-context")
  .description("Build file-focused context from indexed chunks and retained notes.")
  .summary("Inspect indexed context and retained memories linked to specific files.")
  .argument("<files...>", "workspace file paths")
  .option("--term <term>", "additional query term; repeatable", collectOption, [])
  .option("-k, --top-k <number>", "number of search hits to include", parsePositiveInteger, 8)
  .option("--fresh", "refresh changed, deleted, or new source files before building file context")
  .option("--include-superseded-memories", "include retained notes that have been superseded")
  .option("--json", "output structured JSON")
  .addHelpText("after", `

Examples:
  $ kbx file-context src/search.ts
  $ kbx file-context src/search.ts src/mcp.ts --term graph --json
`)
  .action(async (
    files: string[],
    options: {
      term: string[];
      topK: number;
      fresh?: boolean;
      includeSupersededMemories?: boolean;
      json?: boolean;
    }
  ) => {
    const workspace = await requireWorkspace();
    await maybeStartConfiguredWatch(workspace);
    if (options.fresh === true) {
      await refreshWorkspaceFreshness(workspace);
    }

    const result = await buildFileContext(workspace, files, options.term, options.topK, {
      includeSupersededMemories: options.includeSupersededMemories === true
    });
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Files: ${result.files.join(", ")}`);
    if (result.linked_memories.length > 0) {
      console.log("Retained memories:");
      for (const memory of result.linked_memories.slice(0, 10)) {
        console.log(`- ${memory.title} [${memory.type}/${memory.retention.tier}]`);
      }
    } else {
      console.log("Retained memories: none");
    }
    if (result.search_results.length > 0) {
      console.log("Search results:");
      for (const [index, hit] of result.search_results.entries()) {
        console.log(`${index + 1}. ${hit.source}#${hit.chunk_idx} (${hit.score.toFixed(3)}, ${hit.match})`);
        console.log(indent(excerpt(hit.preview)));
      }
    } else {
      console.log("Search results: none");
    }
  });

program
  .command("inspect")
  .description("Show a read-only summary of the current workspace knowledge base.")
  .summary("Inspect sources, freshness, retained memory, and graph state.")
  .option("--source-limit <number>", "maximum recent indexed files to include", parsePositiveInteger, 20)
  .option("--memory-limit <number>", "maximum retained memory notes to include", parsePositiveInteger, 20)
  .option("--json", "output structured JSON")
  .action(async (options: { sourceLimit: number; memoryLimit: number; json?: boolean }) => {
    const workspace = await requireWorkspace();
    const inspection = await buildWorkspaceInspection(workspace, {
      sourceLimit: options.sourceLimit,
      memoryLimit: options.memoryLimit
    });
    if (options.json === true) {
      console.log(JSON.stringify(inspection, null, 2));
      return;
    }

    console.log("kbx inspect");
    console.log(`Workspace: ${inspection.workspace.name} (${inspection.workspace.id.slice(0, 8)})`);
    console.log(`Model: ${inspection.model.id} (${inspection.model.dim}d)`);
    console.log(`Files: ${inspection.index.files}`);
    console.log(`Chunks: ${inspection.index.chunks}`);
    console.log(`Freshness: ${"stale" in inspection.index.freshness ? `${inspection.index.freshness.stale} stale, ${inspection.index.freshness.deleted} deleted, ${inspection.index.freshness.newFiles} new` : "unavailable"}`);
    console.log(`Sources: ${inspection.sources.length}`);
    console.log(`Memories: ${inspection.memories.total} total, ${inspection.memories.latest} latest, ${inspection.memories.superseded} superseded`);
    console.log(`Graph: ${inspection.graph ? "available" : "not built"}`);
  });

program
  .command("watch")
  .description("Keep the current workspace index fresh while files change.")
  .summary("Watch manifest sources and refresh changed or deleted files during agent sessions.")
  .argument("[path]", "workspace file or directory to watch")
  .option("--background", "start one detached background watcher and return")
  .option("--stop", "stop the detached background watcher for this workspace")
  .option("--status", "show detached watcher status")
  .addOption(new Option("--daemon", "run as an internal detached watcher child").hideHelp())
  .addHelpText("after", `

Examples:
  $ kbx watch
  $ kbx watch docs
  $ kbx watch --background
  $ kbx watch --stop

This is equivalent to a long-running hot ingest loop. Press Ctrl+C to stop foreground mode.
`)
  .action(async (
    targetPath: string | undefined,
    options: { background?: boolean; stop?: boolean; status?: boolean; daemon?: boolean }
  ) => {
    const workspace = await requireWorkspace();
    const target = targetPath ? path.resolve(targetPath) : undefined;

    if (options.stop === true) {
      const stopped = await stopBackgroundWatch(workspace);
      console.log(stopped.stopped ? `Stopped background watcher${stopped.pid ? ` (pid ${stopped.pid})` : ""}.` : "No background watcher is recorded.");
      return;
    }

    if (options.status === true) {
      const config = await loadConfig(workspace);
      console.log(JSON.stringify(await watchStatus(workspace, config.watch.auto), null, 2));
      return;
    }

    if (options.background === true) {
      const result = await startBackgroundWatch(workspace, target);
      console.log(`${result.started ? "Started" : "Background watcher already running"} (pid ${result.pid}).`);
      console.log(`Log: ${result.log_file}`);
      return;
    }

    await watchIngest(workspace, target, { daemon: options.daemon === true });
  });

const mcpCommand = program
  .command("mcp")
  .description("Run the MCP server over stdio.")
  .summary("Expose kbx search, refresh, and gated maintenance tools to MCP clients.")
  .addHelpText("after", `

Example MCP config:
  {
    "mcpServers": {
      "kbx": { "command": "kbx", "args": ["mcp"] }
    }
  }

Tools:
  kbx_search, kbx_list_sources, kbx_get_chunk, kbx_index_status
`)
  .action(async () => {
    const workspace = await requireWorkspace();
    await maybeStartConfiguredWatch(workspace, { silent: true });
    await runMcpServer(workspace);
  });

mcpCommand
  .command("config")
  .description("Print an MCP config snippet for an AI client.")
  .summary("Generate client-specific config for Claude, Cursor, Codex, Gemini, and other MCP clients.")
  .argument("[client]", "MCP client adapter ID or alias")
  .option("--list", "list supported client adapters")
  .option("--server-name <name>", "server name to use in the client config")
  .option("--command <command>", "command that starts kbx")
  .option("--arg <arg>", "argument to pass to the command; repeatable", collectOption, [])
  .addHelpText("after", `

Examples:
  $ kbx mcp config claude
  $ kbx mcp config cursor
  $ kbx mcp config codex
  $ kbx mcp config zed
  $ kbx mcp config --list

Default command:
  "kbx" with args ["mcp"]
`)
  .action((client: string | undefined, options: {
    list?: boolean;
    serverName?: string;
    command?: string;
    arg: string[];
  }) => {
    if (options.list === true) {
      for (const adapter of listAdapters()) {
        console.log(`${adapter.id.padEnd(18)} ${adapter.clientName.padEnd(22)} ${adapter.configPath}`);
      }
      return;
    }

    if (!client) {
      throw new Error("Missing client. Run kbx mcp config --list to see supported clients.");
    }

    const snippet = generateAdapterConfig(client, {
      serverName: options.serverName,
      command: options.command,
      args: options.arg.length > 0 ? options.arg : undefined
    });

    console.log(`# ${snippet.clientName}`);
    console.log(`# ${snippet.configPath}`);
    for (const note of snippet.notes) {
      console.log(`# ${note}`);
    }
    console.log(snippet.content);
  });

const hookCommand = program
  .command("hook")
  .description("Run kbx hook handlers for supported agent clients.")
  .summary("Internal command used by generated agent hook adapters.");

hookCommand
  .command("claude-code")
  .description("Run Claude Code hook handlers.")
  .argument("<event>", "hook event handler")
  .action(async (event: string) => {
    if (event !== "post-tool-use") {
      throw new Error("Unknown Claude Code hook event. Supported: post-tool-use.");
    }
    const input = await readStdin();
    const result = await handleClaudeCodePostToolUse(input);
    console.log(JSON.stringify(result));
  });

hookCommand
  .command("files")
  .description("Run a generic file refresh hook handler.")
  .argument("<event>", "hook event handler")
  .addHelpText("after", `

Examples:
  $ printf '{"paths":["src/app.ts"]}' | kbx hook files refresh

Input can be JSON with path/file_path/paths/file_paths/files, a JSON string array,
or newline-delimited file paths.
`)
  .action(async (event: string) => {
    if (event !== "refresh") {
      throw new Error("Unknown files hook event. Supported: refresh.");
    }
    const input = await readStdin();
    const result = await handleFileRefreshHook(input);
    console.log(JSON.stringify(result));
  });

hookCommand
  .command("session")
  .description("Run a generic opt-in session capture hook handler.")
  .argument("<event>", "hook event handler")
  .addHelpText("after", `

Examples:
  $ printf '{"session_id":"abc","tool_name":"Edit"}' | kbx hook session capture

Session capture respects sessions.capture. It is disabled by default.
`)
  .action(async (event: string) => {
    if (event !== "capture") {
      throw new Error("Unknown session hook event. Supported: capture.");
    }
    const input = await readStdin();
    const result = await handleSessionCaptureHook(input);
    console.log(JSON.stringify(result));
  });

const agentCommand = program
  .command("agent")
  .description("Agent helper commands.")
  .summary("Print guidance and helper information for AI assistant integrations.");

agentCommand
  .command("guide")
  .description("Print agent usage guidance for kbx tools.")
  .summary("Show when agents should search, refresh, fetch chunks, and avoid destructive operations.")
  .action(() => {
    console.log(KBX_AGENT_GUIDE);
  });

agentCommand
  .command("hooks")
  .description("Print hook configuration for supported AI clients.")
  .summary("Generate client hook snippets that keep kbx fresh after agent edits.")
  .argument("[client]", "hook-capable client adapter ID or alias", "claude-code")
  .option("--command <command>", "command that starts kbx", "kbx")
  .addHelpText("after", `

Examples:
  $ kbx agent hooks claude-code

The generated hook config is additive. Merge it with existing client settings.
`)
  .action((client: string, options: { command: string }) => {
    const snippet = generateAdapterHooks(client, { command: options.command });
    console.log(`# ${snippet.clientName}`);
    console.log(`# ${snippet.configPath}`);
    for (const note of snippet.notes) {
      console.log(`# ${note}`);
    }
    console.log(snippet.content);
  });

agentCommand
  .command("plugin")
  .description("Print plugin installation guidance for supported agent clients.")
  .summary("Show local plugin paths and install commands for Claude Code.")
  .argument("[client]", "plugin-capable client", "claude-code")
  .action((client: string) => {
    if (client !== "claude-code") {
      throw new Error("Only claude-code has a packaged kbx plugin. Use `kbx mcp config --list` for MCP-only clients.");
    }
    const root = packageRoot();
    const pluginPath = path.join(root, "plugins", "claude-code", "kbx");
    console.log("Claude Code plugin");
    console.log(`Plugin path: ${pluginPath}`);
    console.log("Test locally:");
    console.log(`  claude --plugin-dir ${JSON.stringify(pluginPath)}`);
    console.log("Install from this repository marketplace inside Claude Code:");
    console.log(`  /plugin marketplace add ${JSON.stringify(root)}`);
    console.log("  /plugin install kbx@kbx-tools");
    console.log("For Codex CLI:");
    console.log("  kbx mcp config codex");
    console.log("For Claude Desktop / Claude MCP config:");
    console.log("  kbx mcp config claude");
  });

const devCommand = program
  .command("dev")
  .description("Developer-mode helpers.")
  .summary("Record opt-in local debug reports for kbx-assisted Codex sessions.");

const devReportCommand = devCommand
  .command("report")
  .description("Manage opt-in kbx dev reports.")
  .summary("Save or list small local reports under .kbx/debug/reports.");

devReportCommand
  .command("add")
  .description("Save a small local dev report when dev.report is enabled.")
  .requiredOption("--task <text>", "task or request that was handled")
  .requiredOption("--summary <text>", "short summary of what happened")
  .option("--issue <text>", "issue, risk, or problem observed; repeatable", collectOption, [])
  .option("--finding <text>", "neutral finding or observation; repeatable", collectOption, [])
  .option("--good <text>", "thing that worked well; repeatable", collectOption, [])
  .option("--next <text>", "suggested follow-up; repeatable", collectOption, [])
  .option("--source <name>", "report source", "codex")
  .option("--json", "output structured JSON")
  .addHelpText("after", `

Examples:
  $ kbx config set dev.report enabled
  $ kbx dev report add --task "fix search" --summary "Updated search tests" --good "MCP context was relevant"

Reports are disabled by default and are stored locally under .kbx/debug/reports.
`)
  .action(async (options: {
    task: string;
    summary: string;
    issue: string[];
    finding: string[];
    good: string[];
    next: string[];
    source: string;
    json?: boolean;
  }) => {
    const workspace = await requireWorkspace();
    const report = await addDevReport(workspace, {
      task: options.task,
      summary: options.summary,
      issues: options.issue,
      findings: options.finding,
      good: options.good,
      next: options.next,
      source: options.source
    });
    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (report.skipped) {
      console.log("Dev report skipped: dev.report is disabled. Enable with `kbx config set dev.report enabled`.");
      return;
    }
    console.log(`Saved dev report: ${report.relative_path}`);
  });

devReportCommand
  .command("list")
  .description("List recent local dev reports.")
  .option("--limit <number>", "maximum reports to list", parsePositiveInteger, 20)
  .option("--json", "output structured JSON")
  .action(async (options: { limit: number; json?: boolean }) => {
    const workspace = await requireWorkspace();
    const reports = await listDevReports(workspace, options.limit);
    if (options.json === true) {
      console.log(JSON.stringify({ reports }, null, 2));
      return;
    }
    if (reports.length === 0) {
      console.log("No dev reports.");
      return;
    }
    for (const [index, report] of reports.entries()) {
      console.log(`${index + 1}. ${report.relative_path}`);
      console.log(indent(report.preview));
    }
  });

program
  .command("config")
  .description("View or edit workspace config.")
  .summary("Read or change workspace-local kbx settings.")
  .argument("<action>", "get or set")
  .argument("[key]", "config key")
  .argument("[value]", "config value")
  .option("--global", "read or change user-level kbx settings")
  .addHelpText("after", `

Examples:
  $ kbx config get
  $ kbx config get chunk.size
  $ kbx config set chunk.size 1200
  $ kbx config set mcp.citations full-path
  $ kbx config set mcp.destructive_tools enabled
  $ kbx config set watch.auto enabled
  $ kbx config set dev.report enabled
  $ kbx config set init.root_preference git-root --global

Keys:
  chunk.size, chunk.overlap, chunk.strategy (heading|fixed|sentence), mcp.citations, mcp.destructive_tools
  sessions.*, graph.*, watch.auto, dev.report (disabled|enabled), init.root_preference (--global)
`)
  .action(async (action: string, key?: string, value?: string, options?: { global?: boolean }) => {
    if (options?.global === true || key?.startsWith("init.")) {
      const config = await loadUserConfig();

      if (action === "get") {
        if (key) {
          console.log(String(getUserConfigValue(config, key)));
          return;
        }

        for (const entry of listUserConfigValues(config)) {
          console.log(`${entry.key}=${entry.value}`);
        }
        return;
      }

      if (action === "set") {
        if (!key || value === undefined) {
          throw new Error("Usage: kbx config set <key> <value> --global");
        }
        await saveUserConfig(setUserConfigValue(config, key, value));
        console.log(`${key}=${value}`);
        return;
      }

      throw new Error("Config action must be get or set.");
    }

    const workspace = await requireWorkspace();
    const config = await loadConfig(workspace);

    if (action === "get") {
      if (key) {
        console.log(String(getConfigValue(config, key)));
        return;
      }

      for (const entry of listConfigValues(config)) {
        console.log(`${entry.key}=${entry.value}`);
      }
      return;
    }

    if (action === "set") {
      if (!key || value === undefined) {
        throw new Error("Usage: kbx config set <key> <value>");
      }
      const nextConfig = setConfigValue(config, key, value);
      await saveConfig(workspace, nextConfig);
      console.log(`${key}=${value}`);
      if (key === "watch.auto" && nextConfig.watch.auto === "enabled") {
        await maybeStartConfiguredWatch(workspace);
      }
      return;
    }

    throw new Error("Config action must be get or set.");
  });

program
  .command("status")
  .description("Show workspace, index, source, and freshness status.")
  .summary("Print a readable status report for the nearest kbx workspace.")
  .option("--fresh", "scan source files for stale/deleted/new files")
  .option("--json", "output structured JSON")
  .addHelpText("after", `

Examples:
  $ kbx status
  $ kbx status --fresh
  $ kbx status --json
`)
  .action(async (options: { fresh?: boolean; json?: boolean }) => {
    const workspace = await findWorkspace(process.cwd());
    if (!workspace) {
      if (options.json === true) {
        console.log(JSON.stringify({ initialized: false, cwd: process.cwd() }, null, 2));
        return;
      }
      console.log("kbx status");
      console.log("Workspace: not initialized");
      console.log("Next: run kbx setup or kbx init");
      return;
    }

    const [manifest, sources] = await Promise.all([
      loadManifest(workspace),
      loadSources(workspace)
    ]);
    const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
    const indexSize = await directorySizeBytes(workspace.collectionDir);
    const chunkCount = await vectorChunkCount(workspace, manifest.dim);
    const freshness = options.fresh === true ? await scanWorkspaceFreshness(workspace) : undefined;

    if (options.json === true) {
      console.log(JSON.stringify({
        initialized: true,
        workspace: {
          id: manifest.workspace_id,
          name: manifest.name,
          path: workspace.root
        },
        model: {
          id: manifest.model,
          label: modelLabel(manifest.model),
          dim: manifest.dim
        },
        index: {
          documents: Object.keys(stats.files).length,
          chunks: chunkCount,
          size_bytes: indexSize,
          last_ingest_at: stats.last_ingest_at || null
        },
        sources: sources.length,
        freshness
      }, null, 2));
      return;
    }

    console.log("kbx status");
    console.log("");
    console.log("Workspace:");
    console.log(`  Name:       ${manifest.name} (${manifest.workspace_id.slice(0, 8)})`);
    console.log(`  Root:       ${workspace.root}`);
    console.log(`  Model:      ${modelLabel(manifest.model)} (${manifest.dim}d)`);
    console.log("");
    console.log("Index:");
    console.log(`  Documents:  ${Object.keys(stats.files).length}`);
    console.log(`  Chunks:     ${chunkCount}`);
    console.log(`  Size:       ${formatBytes(indexSize)}`);
    console.log(`  Ingested:   ${stats.last_ingest_at || "never"}`);
    console.log("");
    console.log("Sources:");
    console.log(`  Count:      ${sources.length}`);
    if (freshness) {
      console.log("");
      console.log("Freshness:");
      console.log(`  Stale:      ${freshness.stale}`);
      console.log(`  Deleted:    ${freshness.deleted}`);
      console.log(`  New:        ${freshness.newFiles}`);
      if (freshness.stale + freshness.deleted + freshness.newFiles > 0) {
        console.log("  Next:       run kbx ingest or kbx doctor --repair");
      }
    }
  });

program
  .command("stats")
  .description("Show basic workspace metadata.")
  .summary("Print stored index metadata, optionally scanning freshness.")
  .option("--fresh", "scan source files for stale/deleted/new files")
  .addHelpText("after", `

Examples:
  $ kbx stats
  $ kbx stats --fresh
`)
  .action(async (options: { fresh?: boolean }) => {
    const workspace = await findWorkspace(process.cwd());
    if (!workspace) {
      throw new Error("No kbx workspace found. Run kbx init first.");
    }
    const manifest = await loadManifest(workspace);
    const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
    const indexSize = await directorySizeBytes(workspace.collectionDir);
    let chunkCount = 0;
    try {
      const store = await ChunkVectorStore.open(workspace, manifest.dim, { readOnly: true });
      try {
        chunkCount = store.docCount;
      } finally {
        store.close();
      }
    } catch {
      chunkCount = 0;
    }
    console.log(`Workspace: ${manifest.name} (${manifest.workspace_id.slice(0, 8)})`);
    console.log(`Model: ${manifest.model} (${manifest.dim}d)`);
    console.log(`Documents: ${Object.keys(stats.files).length}`);
    console.log(`Chunks: ${chunkCount}`);
    console.log(`Index size: ${formatBytes(indexSize)}`);
    console.log(`Last ingest: ${stats.last_ingest_at || "never"}`);
    if (options.fresh === true) {
      const fresh = await freshnessLine(workspace, stats);
      console.log(`Freshness: ${fresh.detail}`);
    }
    console.log(`Registry: ${registryPath()}`);
  });

program
  .command("reset")
  .description("Clear current workspace index, preserving config and identity.")
  .summary("Delete derived vectors and stats for the current workspace.")
  .option("-y, --yes", "skip confirmation")
  .addHelpText("after", `

Examples:
  $ kbx reset
  $ kbx reset --yes

Reset preserves .kbx/config.json, manifest.json, sources.json, and registry identity.
`)
  .action(async (options: { yes?: boolean }) => {
    const workspace = await requireWorkspace();
    const ok = options.yes === true || await confirmAction("Clear the current workspace index?");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }

    await resetWorkspaceIndex(workspace);
    console.log("Reset workspace index.");
  });

const workspaceCommand = program
  .command("workspace")
  .description("Manage registered workspaces.")
  .summary("List, forget, or delete workspace knowledge bases.")
  .addHelpText("after", `

Examples:
  $ kbx workspace list
  $ kbx workspace forget <workspace-id>
  $ kbx workspace delete <workspace-id>
`);

workspaceCommand
  .command("list")
  .description("List registered workspaces.")
  .action(async () => {
    const registry = await loadRegistry();
    if (registry.length === 0) {
      console.log("No registered workspaces.");
      return;
    }

    for (const entry of registry) {
      console.log(`${entry.workspace_id.slice(0, 8)}  ${entry.name}  ${entry.path}`);
    }
  });

workspaceCommand
  .command("forget")
  .description("Remove a workspace from the registry only.")
  .argument("<selector>", "workspace ID, unique name, or path")
  .action(async (selector: string) => {
    const entry = await forgetWorkspace(selector);
    console.log(`Forgot ${entry.name} (${entry.workspace_id.slice(0, 8)}).`);
  });

workspaceCommand
  .command("delete")
  .description("Delete a workspace .kbx/ directory after confirmation.")
  .argument("<selector>", "workspace ID, unique name, or path")
  .option("-y, --yes", "skip confirmation")
  .action(async (selector: string, options: { yes?: boolean }) => {
    const ok = options.yes === true || await confirmAction(`Delete .kbx/ for "${selector}"?`);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }

    const entry = await deleteWorkspaceKnowledgeBase(selector);
    console.log(`Deleted knowledge base for ${entry.name} (${entry.workspace_id.slice(0, 8)}).`);
  });

const sourcesCommand = program
  .command("sources")
  .description("Manage ingest sources.")
  .summary("List or remove source roots recorded in .kbx/sources.json.")
  .addHelpText("after", `

Examples:
  $ kbx sources list
  $ kbx sources remove 2
  $ kbx sources remove 2 --delete-import --yes
`);

sourcesCommand
  .command("list")
  .description("List ingest roots.")
  .action(async () => {
    const workspace = await requireWorkspace();
    const sources = await loadSources(workspace);
    if (sources.length === 0) {
      console.log("No sources.");
      return;
    }

    for (const [index, source] of sources.entries()) {
      console.log(`${index + 1}. ${source.path} (${source.kind})`);
    }
  });

sourcesCommand
  .command("remove")
  .description("Remove a source entry and its indexed chunks.")
  .argument("<selector>", "source index or path")
  .option("-y, --yes", "skip confirmation")
  .option("--delete-import", "delete copied files for an external import source")
  .action(async (selector: string, options: { yes?: boolean; deleteImport?: boolean }) => {
    const workspace = await requireWorkspace();
    const selected = resolveSourceEntry(await loadSources(workspace), selector).source;
    const ok = options.yes === true || await confirmAction(`Remove source "${selector}" and its indexed chunks?`);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }

    const deleteImportSnapshot = selected.kind === "external_import"
      && (options.deleteImport === true || (process.stdin.isTTY && await confirmAction("Delete the copied external import snapshot too?")));
    const result = await removeSource(workspace, selector, { deleteImportSnapshot });
    console.log(`Removed source ${result.source}; deleted chunks for ${result.removedFiles} file(s).`);
    if (result.deletedImportSnapshot) {
      console.log("Deleted external import snapshot.");
    }
  });

const memoryCommand = program
  .command("memory")
  .description("Manage optional compact session memory.")
  .summary("Add, list, and prune retention-bound session memory notes.")
  .addHelpText("after", `

Examples:
  $ kbx memory add "Decision: keep v1 retrieval-only." --retention-days 30
  $ kbx memory add "ADR follow-up: revisit hooks after MCP adapters settle." --title "Hook follow-up" --retention-days 14
  $ kbx memory list
  $ kbx memory verify <memory-id>
  $ kbx memory history <memory-id>
  $ kbx memory prune

Session memory stores compact notes under .kbx/sessions and indexes them only after explicit retention is provided.
`);

memoryCommand
  .command("add")
  .description("Add a compact session memory note and index it.")
  .argument("<text>", "compact summary or event to remember")
  .option("--title <title>", "short memory title")
  .option("--type <type>", "memory type: decision, preference, architecture, bug, workflow, fact, handoff, or event", validateMemoryType, "fact")
  .option("--file <path>", "relevant workspace file path (repeatable)", collectValues, [])
  .option("--tag <tag>", "memory tag (repeatable)", collectValues, [])
  .option("--source-chunk-id <id>", "supporting chunk id (repeatable)", collectValues, [])
  .option("--supersedes <id>", "older memory id superseded by this note (repeatable)", collectValues, [])
  .requiredOption("--retention-days <days>", "number of days before this memory expires", parsePositiveInteger)
  .action(async (text: string, options: { title?: string; type: "decision" | "preference" | "architecture" | "bug" | "workflow" | "fact" | "handoff" | "event"; file: string[]; tag: string[]; sourceChunkId: string[]; supersedes: string[]; retentionDays: number }) => {
    const workspace = await requireWorkspace();
    const { entry, source } = await addSessionMemory(workspace, {
      text,
      title: options.title,
      type: options.type,
      files: options.file,
      tags: options.tag,
      sourceChunkIds: options.sourceChunkId,
      supersedes: options.supersedes,
      retentionDays: options.retentionDays
    });
    const result = await ingestSource(workspace, source);
    console.log(`Added session memory ${entry.id} (${entry.title}).`);
    console.log(`Expires: ${entry.expires_at}`);
    console.log(`Indexed ${result.chunks} chunk(s).`);
  });

memoryCommand
  .command("list")
  .description("List compact session memory notes.")
  .action(async () => {
    const workspace = await requireWorkspace();
    const entries = await listSessionMemories(workspace);
    if (entries.length === 0) {
      console.log("No session memories.");
      return;
    }

    for (const entry of entries) {
      console.log(`${entry.id.slice(0, 8)}  [${entry.type}/${entry.retention.tier} ${entry.retention.score.toFixed(2)}] ${entry.title}  expires ${entry.expires_at}`);
    }
  });

memoryCommand
  .command("verify")
  .description("Verify a memory's supporting indexed chunk citations.")
  .argument("<id>", "memory id or unique id prefix")
  .option("--json", "output structured JSON")
  .action(async (id: string, options: { json?: boolean }) => {
    const workspace = await requireWorkspace();
    const verification = await buildMemoryVerification(workspace, id);
    if (options.json === true) {
      console.log(JSON.stringify(verification, null, 2));
      return;
    }

    console.log(`Memory: ${verification.memory.title} (${verification.memory.id})`);
    console.log(`Status: ${verification.status}`);
    console.log(`Type: ${verification.memory.type}`);
    console.log(`Latest: ${verification.memory.is_latest ? "yes" : "no"}`);
    console.log(`Retention: ${verification.memory.retention.tier} ${verification.memory.retention.score.toFixed(2)}, ${verification.memory.retention.days_remaining} day(s) remaining`);
    if (verification.memory.superseded_by) {
      console.log(`Superseded by: ${verification.memory.superseded_by}`);
    }
    if (verification.memory.supersedes.length > 0) {
      console.log(`Supersedes: ${verification.memory.supersedes.join(", ")}`);
    }
    console.log(`Support chunks: ${verification.citations.length}/${verification.memory.source_chunk_ids.length}`);
    for (const citation of verification.citations) {
      console.log(`- ${citation.id} ${citation.source}#${citation.chunk_idx}`);
    }
    if (verification.missing_source_chunk_ids.length > 0) {
      console.log(`Missing: ${verification.missing_source_chunk_ids.join(", ")}`);
    }
  });

memoryCommand
  .command("history")
  .description("Show a retained memory supersession history chain.")
  .argument("<id>", "memory id or unique id prefix")
  .option("--json", "output structured JSON")
  .action(async (id: string, options: { json?: boolean }) => {
    const workspace = await requireWorkspace();
    const history = await buildMemoryHistory(workspace, id);
    if (options.json === true) {
      console.log(JSON.stringify(history, null, 2));
      return;
    }

    console.log(`Memory history: ${history.memory.title} (${history.memory.id})`);
    console.log(`Chain: ${history.summary.chain_length} total, ${history.summary.latest} latest, ${history.summary.superseded} superseded`);
    for (const entry of history.chain) {
      const marker = entry.id === history.memory.id ? "*" : "-";
      const state = entry.is_latest ? "latest" : `superseded by ${entry.superseded_by ?? "unknown"}`;
      console.log(`${marker} ${entry.id} [${entry.type}/${entry.retention.tier}] ${entry.title} (${state})`);
    }
  });

memoryCommand
  .command("prune")
  .description("Delete expired session memories and refresh their index source.")
  .action(async () => {
    const workspace = await requireWorkspace();
    const expired = await pruneExpiredSessionMemories(workspace);
    const source = sessionMemorySource(await loadSources(workspace));
    if (source) {
      await ingestSource(workspace, source);
    }
    console.log(`Pruned ${expired.length} expired session memory note(s).`);
  });

const sessionCommand = program
  .command("session")
  .description("Manage opt-in durable agent sessions.")
  .summary("Start, record, inspect, checkpoint, replay, and prune session event timelines.")
  .addHelpText("after", `

Examples:
  $ kbx config set sessions.capture full
  $ kbx session start --client codex --name "ADR work"
  $ kbx session record <session-id> --type note --summary "Reviewed replay design"
  $ kbx session replay <session-id>

Session capture is disabled by default. Use sessions.capture=metadata or full to enable hook capture.
`);

sessionCommand
  .command("start")
  .description("Start a durable session record.")
  .option("--name <name>", "human label for the session")
  .option("--client <client>", "agent or client name")
  .action(async (options: { name?: string; client?: string }) => {
    const workspace = await requireWorkspace();
    const session = await startSession(workspace, {
      name: options.name,
      client: options.client
    });
    console.log(JSON.stringify({ session }, null, 2));
  });

sessionCommand
  .command("end")
  .description("Mark a durable session as ended.")
  .argument("<session-id>", "session id")
  .action(async (sessionId: string) => {
    const workspace = await requireWorkspace();
    const session = await endSession(workspace, sessionId);
    console.log(JSON.stringify({ session }, null, 2));
  });

sessionCommand
  .command("list")
  .description("List recent durable sessions.")
  .option("--limit <number>", "maximum sessions to print", parsePositiveInteger, 50)
  .action(async (options: { limit: number }) => {
    const workspace = await requireWorkspace();
    const sessions = await listSessions(workspace, { limit: options.limit });
    if (sessions.length === 0) {
      console.log("No sessions.");
      return;
    }
    for (const session of sessions) {
      console.log(`${session.id.slice(0, 8)}  ${session.status.padEnd(6)}  ${session.started_at}  ${session.name ?? session.client ?? ""}`);
    }
  });

sessionCommand
  .command("show")
  .description("Show one durable session.")
  .argument("<session-id>", "session id")
  .action(async (sessionId: string) => {
    const workspace = await requireWorkspace();
    const session = await getSession(workspace, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    console.log(JSON.stringify({ session }, null, 2));
  });

sessionCommand
  .command("events")
  .description("List events for one durable session.")
  .argument("<session-id>", "session id")
  .option("--limit <number>", "maximum events to print", parsePositiveInteger, 500)
  .action(async (sessionId: string, options: { limit: number }) => {
    const workspace = await requireWorkspace();
    const events = await listSessionEvents(workspace, sessionId, { limit: options.limit });
    if (events.length === 0) {
      console.log("No events.");
      return;
    }
    for (const event of events) {
      console.log(`${String(event.seq).padStart(4)}  ${event.timestamp}  ${event.type.padEnd(10)}  ${event.summary}`);
    }
  });

sessionCommand
  .command("record")
  .description("Record one event into a durable session.")
  .argument("<session-id>", "session id")
  .requiredOption("--type <type>", "event type: prompt, assistant, tool, file_edit, checkpoint, note, error, other")
  .option("--summary <summary>", "short event summary")
  .option("--tool <tool>", "tool name")
  .option("--input-json <json>", "JSON input payload")
  .option("--output-json <json>", "JSON output payload")
  .option("--error <message>", "error text")
  .option("--file <path>", "file affected by this event; repeatable", collectOption, [])
  .option("--operation <operation>", "operation for --file entries", "edit")
  .option("--before-text <text>", "file content before the edit for rewind")
  .option("--after-text <text>", "file content after the edit for rewind")
  .action(async (sessionId: string, options: {
    type: string;
    summary?: string;
    tool?: string;
    inputJson?: string;
    outputJson?: string;
    error?: string;
    file: string[];
    operation: string;
    beforeText?: string;
    afterText?: string;
  }) => {
    const workspace = await requireWorkspace();
    const event = await appendSessionEvent(workspace, {
      sessionId,
      type: parseSessionEventType(options.type),
      summary: options.summary,
      toolName: options.tool,
      input: options.inputJson ? parseJsonLiteral(options.inputJson, "--input-json") : undefined,
      output: options.outputJson ? parseJsonLiteral(options.outputJson, "--output-json") : undefined,
      error: options.error,
      files: options.file.map((filePath) => ({ path: filePath, operation: options.operation })),
      snapshots: options.file.length > 0 && (options.beforeText !== undefined || options.afterText !== undefined)
        ? options.file.map((filePath) => ({ path: filePath, beforeText: options.beforeText ?? null, afterText: options.afterText ?? null }))
        : undefined
    });
    console.log(JSON.stringify(event, null, 2));
  });

sessionCommand
  .command("checkpoint")
  .description("Add a named checkpoint to a durable session.")
  .argument("<session-id>", "session id")
  .argument("<name>", "checkpoint name")
  .option("--note <note>", "optional checkpoint note")
  .action(async (sessionId: string, name: string, options: { note?: string }) => {
    const workspace = await requireWorkspace();
    const checkpoint = await addSessionCheckpoint(workspace, sessionId, name, options.note);
    console.log(JSON.stringify(checkpoint, null, 2));
  });

sessionCommand
  .command("replay")
  .description("Print a read-only timeline for a durable session.")
  .argument("<session-id>", "session id")
  .action(async (sessionId: string) => {
    const workspace = await requireWorkspace();
    const timeline = await sessionTimeline(workspace, sessionId);
    console.log(JSON.stringify({ session_id: sessionId, timeline }, null, 2));
  });

sessionCommand
  .command("prune")
  .description("Delete sessions older than retention policy.")
  .option("--retention-days <days>", "override sessions.retention_days", parsePositiveInteger)
  .action(async (options: { retentionDays?: number }) => {
    const workspace = await requireWorkspace();
    const deleted = await pruneSessions(workspace, options.retentionDays);
    console.log(`Pruned ${deleted} session(s).`);
  });

const rewindCommand = program
  .command("rewind")
  .description("Preview or apply a session rewind from recorded file snapshots.")
  .summary("Restore workspace files to their pre-session contents from captured snapshots.");

rewindCommand
  .command("preview")
  .description("Preview the files that a session rewind would restore or delete.")
  .argument("<session-id>", "session id")
  .action(async (sessionId: string) => {
    const workspace = await requireWorkspace();
    console.log(JSON.stringify(await previewSessionRewind(workspace, sessionId), null, 2));
  });

rewindCommand
  .command("apply")
  .description("Apply a session rewind after exact confirmation.")
  .argument("<session-id>", "session id")
  .requiredOption("--confirm <token>", "exact confirmation token printed by rewind preview")
  .action(async (sessionId: string, options: { confirm: string }) => {
    const workspace = await requireWorkspace();
    const result = await applySessionRewind(workspace, sessionId, options.confirm);
    console.log(JSON.stringify(result, null, 2));
  });

const graphCommand = program
  .command("graph")
  .description("Build and query deterministic graph knowledge.")
  .summary("Extract files, headings, symbols, package dependencies, and memory nodes from indexed chunks.");

graphCommand
  .command("build")
  .description("Rebuild graph knowledge from the current lexical index.")
  .option("--max-chunks <number>", "maximum chunks to scan", parsePositiveInteger)
  .action(async (options: { maxChunks?: number }) => {
    const workspace = await requireWorkspace();
    const result = await buildGraph(workspace, { maxChunks: options.maxChunks });
    console.log(JSON.stringify(result, null, 2));
  });

graphCommand
  .command("query")
  .description("Query graph nodes and their immediate relations.")
  .argument("<query>", "node, symbol, heading, dependency, or memory term")
  .option("--limit <number>", "maximum matching nodes", parsePositiveInteger, 20)
  .option("--json", "output structured JSON")
  .action(async (query: string, options: { limit: number; json?: boolean }) => {
    const workspace = await requireWorkspace();
    console.log(JSON.stringify(await queryGraph(workspace, query, { limit: options.limit }), null, 2));
  });

graphCommand
  .command("stats")
  .description("Show graph node and edge counts.")
  .action(async () => {
    const workspace = await requireWorkspace();
    console.log(JSON.stringify(await graphStats(workspace), null, 2));
  });

program
  .command("doctor")
  .description("Diagnose environment and workspace health.")
  .summary("Check workspace, platform, registry, collection, model, and optional freshness/benchmarks.")
  .option("--fresh", "scan source files for stale/deleted/new files")
  .option("--bench", "run a small local embedding benchmark")
  .option("--deep", "include freshness scan and benchmark")
  .option("--repair", "refresh configured sources before diagnostics to repair freshness or lexical drift")
  .addHelpText("after", `

Examples:
  $ kbx doctor
  $ kbx doctor --fresh
  $ kbx doctor --repair
  $ kbx doctor --deep
`)
  .action(async (options: { fresh?: boolean; bench?: boolean; deep?: boolean; repair?: boolean }) => {
    const workspace = await findWorkspace(process.cwd());
    if (options.repair === true) {
      if (!workspace) {
        throw new Error("No kbx workspace found. Run kbx init first.");
      }
      const repairProgress = createIngestProgress();
      let repair: Awaited<ReturnType<typeof refreshWorkspaceIndex>>;
      try {
        repair = await refreshWorkspaceIndex(workspace, {
          onProgress: repairProgress?.onProgress
        });
      } catch (error) {
        repairProgress?.error();
        throw error;
      } finally {
        await repairProgress?.stop();
      }
      console.log(`repair  refreshed ${repair.files} file(s), ${repair.chunks} new chunk(s), ${repair.skipped} skipped/unchanged, ${repair.deleted} deleted across ${repair.sources} source(s).`);
    }
    const lines = await runDoctor(workspace, {
      fresh: options.fresh === true || options.deep === true || options.repair === true,
      bench: options.bench === true || options.deep === true
    });

    for (const line of lines) {
      console.log(`${line.ok ? "ok" : "fail"}  ${line.label}: ${line.detail}`);
    }

    if (lines.some((line) => !line.ok)) {
      process.exitCode = 1;
    }
  });

const modelCommand = program
  .command("model")
  .description("Inspect and change embedding models.")
  .summary("List, benchmark, and switch supported embedding models.")
  .addHelpText("after", `

Examples:
  $ kbx model list
  $ kbx model benchmark
  $ kbx model load ./nomic-model --as nomic
  $ kbx model use minilm --reindex
`);

modelCommand
  .command("list")
  .description("List supported embedding models.")
  .summary("Show catalog IDs, dimensions, size estimates, and selected model.")
  .action(async () => {
    const workspace = await findWorkspace(process.cwd());
    const currentModel = workspace ? (await loadManifest(workspace)).model : "";
    console.log("ID          Accuracy  Size      Dim    Speed       Memory   Profile    Installed  Selected  Best for");
    for (const model of MODEL_CATALOG) {
      const selected = model.model === currentModel ? "yes" : "no";
      const [benchmark, installed] = await Promise.all([
        cachedModelBenchmark(model.model, model.dim),
        isCatalogModelInstalled(model)
      ]);
      console.log([
        model.id.padEnd(11),
        model.accuracy.padEnd(9),
        model.size.padEnd(9),
        `${model.dim}d`.padEnd(6),
        formatBenchmarkSpeed(benchmark, model.speed).padEnd(11),
        model.memory.padEnd(8),
        model.profile.padEnd(10),
        (installed ? "yes" : "no").padEnd(10),
        selected.padEnd(9),
        model.bestFor
      ].join(" "));
    }
  });

modelCommand
  .command("benchmark")
  .description("Benchmark the current or selected embedding model.")
  .summary("Run a small local embedding throughput test.")
  .argument("[model-id]", "catalog model ID")
  .option("--all", "benchmark every catalog model after confirmation")
  .option("-y, --yes", "skip confirmation")
  .addHelpText("after", `

Examples:
  $ kbx model benchmark
  $ kbx model benchmark minilm
  $ kbx model benchmark --all
`)
  .action(async (modelId: string | undefined, options: { all?: boolean; yes?: boolean }) => {
    const workspace = await requireWorkspace();
    const manifest = await loadManifest(workspace);

    if (options.all === true) {
      const ok = options.yes === true || await confirmAction("Benchmarking all models may download large model files. Continue?");
      if (!ok) {
        console.log("Cancelled.");
        return;
      }

      for (const model of MODEL_CATALOG) {
        const result = await benchmarkLine(model.model, model.dim);
        console.log(`${model.id}: ${result.detail}`);
      }
      return;
    }

    const model = modelId ? resolveModel(modelId) : { id: "current", model: manifest.model, dim: manifest.dim };
    const result = await benchmarkLine(model.model, model.dim);
    console.log(`${model.id}: ${result.detail}`);
  });

modelCommand
  .command("load")
  .description("Install a catalog model from a local directory for offline use.")
  .summary("Copy a Transformers.js-compatible model directory into the local model cache.")
  .argument("<path>", "local model directory containing config.json and onnx/*.onnx")
  .option("--as <model-id>", "catalog model ID this local directory provides")
  .addHelpText("after", `

Examples:
  $ kbx model load ./all-MiniLM-L6-v2 --as minilm
  $ kbx model load ./nomic-embed-text-v1.5 --as nomic
`)
  .action(async (modelPath: string, options: { as?: string }) => {
    const model = options.as ? resolveModel(options.as) : inferModelFromPath(modelPath);
    const destination = await loadCatalogModelFromPath(model, modelPath);
    console.log(`Loaded ${model.id} into ${destination}`);
  });

modelCommand
  .command("use")
  .description("Select a supported embedding model.")
  .summary("Switch model selection; use --reindex when indexed content exists.")
  .argument("[model-id]", "catalog model ID")
  .option("--reindex", "reset and rebuild from sources after switching")
  .option("-y, --yes", "skip confirmation")
  .addHelpText("after", `

Examples:
  $ kbx model use minilm
  $ kbx model use nomic --reindex
  $ kbx model use bge-base --reindex --yes

When indexed content exists, kbx rebuilds into a temporary index before swapping it in.
`)
  .action(async (modelId: string | undefined, options: { reindex?: boolean; yes?: boolean }) => {
    const workspace = await requireWorkspace();
    const model = await resolveRequestedModel(modelId, { interactive: true });
    if (!model) {
      throw new Error("No model selected.");
    }
    const manifest = await loadManifest(workspace);
    if (manifest.model === model.model && manifest.dim === model.dim) {
      console.log(`Model already selected: ${model.id}`);
      return;
    }

    const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
    const hasIndex = Object.keys(stats.files).length > 0;
    let confirmedReindex = false;
    if (hasIndex && options.reindex !== true) {
      if (!process.stdin.isTTY) {
        throw new Error("Switching models requires rebuilding vectors. Re-run with --reindex in non-interactive mode.");
      }
      const ok = await confirmAction(`Switch to ${model.id} and rebuild the current workspace index?`);
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
      options.reindex = true;
      confirmedReindex = true;
    }

    if (hasIndex && options.reindex === true && options.yes !== true && !confirmedReindex) {
      const ok = await confirmAction(`Switch to ${model.id} and rebuild the current workspace index?`);
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
    }

    const sources = await loadSources(workspace);
    const nextManifest = {
      ...manifest,
      model: model.model,
      dim: model.dim,
      updated_at: new Date().toISOString()
    };

    if (options.reindex === true) {
      const reindexProgress = createIngestProgress();
      try {
        await rebuildWorkspaceIndexForModel(workspace, nextManifest, sources, {
          onProgress: reindexProgress?.onProgress
        });
      } catch (error) {
        reindexProgress?.error();
        throw error;
      } finally {
        await reindexProgress?.stop();
      }
    } else {
      await saveManifest(workspace, nextManifest);
      await resetWorkspaceIndex(workspace);
    }

    console.log(`Selected model ${model.id} (${model.dim}d).`);
  });

const evalCommand = program
  .command("eval")
  .description("Run local quality evaluations.")
  .summary("Evaluate retrieval quality against a small JSON corpus.");

evalCommand
  .command("retrieval")
  .description("Evaluate search results against expected source files.")
  .argument("<corpus>", "JSON array of { id, query, relevant: [source] } cases")
  .option("-k, --top-k <number>", "number of hits to evaluate per query", parsePositiveInteger, 5)
  .option("--reranker <mode>", "optional reranker mode: none, local, model, or command", "none")
  .option("--reranker-model <model>", "Transformers.js feature-extraction model for --reranker model")
  .option("--reranker-command <command>", "external reranker command")
  .action(async (corpusPath: string, options: { topK: number; reranker: "none" | "local" | "model" | "command"; rerankerModel?: string; rerankerCommand?: string }) => {
    const workspace = await requireWorkspace();
    const cases = parseRetrievalEvalCorpus(await readFile(path.resolve(corpusPath), "utf8"));
    const resultsByCaseId = new Map<string, Awaited<ReturnType<typeof searchWorkspace>>>();
    for (const testCase of cases) {
      resultsByCaseId.set(testCase.id, await searchWorkspace(workspace, testCase.query, options.topK, {
        reranker: {
          mode: options.reranker,
          model: options.rerankerModel,
          command: options.rerankerCommand
        }
      }));
    }
    const summary = evaluateRetrieval(cases, resultsByCaseId, options.topK);
    console.log(JSON.stringify(summary, null, 2));
  });

program.exitOverride();

program.parseAsync().catch((error: unknown) => {
  if (isCommanderExit(error) && error.exitCode === 0) {
    return;
  }

  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});

interface CliIngestProgress {
  onProgress: (event: IngestProgressEvent) => void;
  error: () => void;
  stop: () => Promise<void>;
}

function createIngestProgress(): CliIngestProgress | undefined {
  const progress = createTerminalProgress();
  if (!progress) {
    return undefined;
  }

  let advancedFiles = 0;

  const onProgress = (event: IngestProgressEvent) => {
    switch (event.phase) {
      case "prepare": {
        progress.update({
          phase: "prepare",
          label: "Preparing workspace",
          detail: shortPath(event.target)
        });
        return;
      }
      case "scan-start": {
        progress.update({
          phase: "scan",
          label: "Scanning files",
          detail: event.source
        });
        return;
      }
      case "scan-complete": {
        if (event.totalFiles === 0) {
          progress.finish(`No indexable files found in ${event.source}.`);
          return;
        }

        advancedFiles = 0;
        progress.update({
          phase: "index",
          label: "Indexing files",
          current: 0,
          total: event.totalFiles,
          detail: event.source
        });
        return;
      }
      case "delete": {
        progress.update({
          phase: "delete",
          label: "Cleaning deleted files",
          count: event.deletedFiles,
          detail: event.source
        });
        return;
      }
      case "file": {
        advancedFiles = event.processedFiles;
        progress.update({
          phase: "index",
          label: "Indexing files",
          current: event.processedFiles,
          total: event.totalFiles,
          detail: ingestProgressMessage(event)
        });
        return;
      }
      case "complete": {
        advancedFiles = event.totalFiles;
        progress.finish(ingestCompleteMessage(event));
        return;
      }
    }
  };

  return {
    onProgress,
    error: () => {
      progress.error("Ingest failed.");
    },
    stop: () => progress.stop()
  };
}

function ingestProgressMessage(event: Extract<IngestProgressEvent, { phase: "file" }>): string {
  const changed = event.processedFiles - event.skippedFiles;
  return `Indexing ${event.processedFiles}/${event.totalFiles} file(s), ${changed} changed, ${event.skippedFiles} skipped/unchanged`;
}

function ingestCompleteMessage(event: Extract<IngestProgressEvent, { phase: "complete" }>): string {
  return `Indexed ${event.totalFiles} file(s), ${event.insertedChunks} new chunk(s), ${event.skippedFiles} skipped/unchanged.`;
}

function shortPath(value: string): string {
  const relative = path.relative(process.cwd(), value);
  if (relative === "") {
    return ".";
  }
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative;
  }
  return value;
}

function isCommanderExit(error: unknown): error is Error & { exitCode: number } {
  return error instanceof Error
    && "exitCode" in error
    && typeof (error as { exitCode?: unknown }).exitCode === "number";
}

async function resolveInitRoot(targetPath: string, options: { here?: boolean; gitRoot?: boolean }): Promise<string> {
  if (options.here === true && options.gitRoot === true) {
    throw new Error("Use only one of --here or --git-root.");
  }
  if ((options.here === true || options.gitRoot === true) && targetPath !== ".") {
    throw new Error("Do not pass a path together with --here or --git-root.");
  }
  if (options.here === true) {
    return process.cwd();
  }
  if (options.gitRoot === true) {
    const gitRoot = await findGitRoot(process.cwd());
    if (!gitRoot) {
      throw new Error("No git root found from the current directory.");
    }
    return gitRoot;
  }
  if (targetPath === ".") {
    const gitRoot = await findGitRoot(process.cwd());
    if (gitRoot && path.resolve(gitRoot) !== path.resolve(process.cwd())) {
      const userConfig = await loadUserConfig();
      const preferred = userConfig.init.root_preference === "git-root" ? gitRoot : process.cwd();
      if (!process.stdin.isTTY) {
        return preferred;
      }

      const selected = await select({
        message: "Choose workspace root for .kbx/",
        initialValue: preferred,
        options: [
          {
            value: process.cwd(),
            label: "Current directory",
            hint: process.cwd()
          },
          {
            value: gitRoot,
            label: "Git root",
            hint: gitRoot
          }
        ]
      });
      if (isCancel(selected)) {
        throw new Error("Workspace initialization cancelled.");
      }
      return String(selected);
    }
  }
  return path.resolve(targetPath);
}

function modelLabel(modelName: string): string {
  return MODEL_CATALOG.find((entry) => entry.model === modelName)?.id ?? modelName;
}

function inferModelFromPath(modelPath: string): ModelCatalogEntry {
  const normalized = modelPath.replaceAll("\\", "/").toLowerCase();
  const basename = path.basename(modelPath).toLowerCase();
  const match = MODEL_CATALOG.find((model) => {
    const repoName = model.model.split("/").at(-1)?.toLowerCase() ?? "";
    return basename === model.id.toLowerCase()
      || basename === repoName
      || normalized.endsWith(`/${model.id.toLowerCase()}`)
      || normalized.endsWith(`/${repoName}`)
      || normalized.includes(`/${repoName}/`);
  });
  if (!match) {
    throw new Error("Could not infer catalog model from path. Pass --as <model-id>.");
  }
  return match;
}

async function resolveRequestedModel(
  modelId: string | undefined,
  options: { interactive: boolean }
): Promise<ModelCatalogEntry | undefined> {
  if (modelId) {
    return resolveModel(modelId);
  }

  if (!options.interactive) {
    return undefined;
  }

  if (!process.stdin.isTTY) {
    throw new Error("Model selection requires an interactive terminal. Pass --model <model-id> instead.");
  }

  const selected = await select({
    message: "Choose a local embedding model",
    initialValue: "nomic",
    options: MODEL_CATALOG.map((model) => ({
      value: model.id,
      label: `${model.id} - ${model.bestFor}`,
      hint: modelDetails(model)
    }))
  });

  if (isCancel(selected)) {
    throw new Error("Model selection cancelled.");
  }

  return resolveModel(String(selected));
}

async function maybeInitWorkspace() {
  if (!process.stdin.isTTY) {
    return null;
  }

  const shouldInit = await confirm({
    message: "No kbx workspace found. Initialize one now?",
    initialValue: true
  });
  if (isCancel(shouldInit) || shouldInit !== true) {
    return null;
  }
  const root = await resolveInitRoot(".", {});
  return initWorkspace(workspaceFromRoot(root).root);
}

function packageRoot(): string {
  const entryDir = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(entryDir) === "dist" || path.basename(entryDir) === "src"
    ? path.dirname(entryDir)
    : entryDir;
}

async function requireWorkspace() {
  const workspace = await findWorkspace(process.cwd());
  if (!workspace) {
    throw new Error("No kbx workspace found. Run kbx init first.");
  }
  return workspace;
}

async function maybeStartConfiguredWatch(
  workspace: Awaited<ReturnType<typeof requireWorkspace>>,
  options: { silent?: boolean } = {}
): Promise<void> {
  const config = await loadConfig(workspace);
  if (config.watch.auto !== "enabled") {
    return;
  }

  const result = await startBackgroundWatch(workspace);
  if (options.silent !== true && result.started) {
    console.error(`Started background watcher (pid ${result.pid}). Log: ${result.log_file}`);
  }
}

async function vectorChunkCount(workspace: Awaited<ReturnType<typeof requireWorkspace>>, dim: number): Promise<number> {
  try {
    const store = await ChunkVectorStore.open(workspace, dim, { readOnly: true });
    try {
      return store.docCount;
    } finally {
      store.close();
    }
  } catch {
    return 0;
  }
}

async function confirmAction(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("Confirmation required. Re-run with --yes in non-interactive mode.");
  }

  const result = await confirm({
    message,
    initialValue: false
  });
  return !isCancel(result) && result === true;
}

function parsePositiveInteger(value: string): number {
  const trimmed = value.trim();
  const parsed = /^(0|[1-9]\d*)$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Expected a positive integer");
  }
  return parsed;
}

function parseSessionEventType(value: string): SessionEventType {
  switch (value) {
    case "prompt":
    case "assistant":
    case "tool":
    case "file_edit":
    case "checkpoint":
    case "note":
    case "error":
    case "other":
      return value;
    default:
      throw new Error("Expected event type prompt, assistant, tool, file_edit, checkpoint, note, error, or other");
  }
}

function validateMemoryType(value: string): "decision" | "preference" | "architecture" | "bug" | "workflow" | "fact" | "handoff" | "event" {
  switch (value) {
    case "decision":
    case "preference":
    case "architecture":
    case "bug":
    case "workflow":
    case "fact":
    case "handoff":
    case "event":
      return value;
    default:
      throw new Error("Expected memory type decision, preference, architecture, bug, workflow, fact, handoff, or event");
  }
}

function parseJsonLiteral(value: string, optionName: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${optionName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectValues(value: string, previous: string[]): string[] {
  return collectOption(value, previous);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function excerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 320 ? `${compact.slice(0, 317)}...` : compact;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}
