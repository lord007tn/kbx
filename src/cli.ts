#!/usr/bin/env node
import { confirm, isCancel, progress, select, spinner, type ProgressResult, type SpinnerResult } from "@clack/prompts";
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { KBX_AGENT_GUIDE } from "./agent-guide";
import { getConfigValue, getUserConfigValue, listConfigValues, listUserConfigValues, setConfigValue, setUserConfigValue } from "./config";
import { benchmarkLine, freshnessLine, runDoctor } from "./doctor";
import { directorySizeBytes, formatBytes } from "./io";
import { ingestSource, ingestWorkspaceTarget, loadIndexStats, rebuildWorkspaceIndexForModel, refreshWorkspaceFreshness, refreshWorkspaceIndex, removeSource, resetWorkspaceIndex, resolveSourceEntry, type IngestProgressEvent, type IngestResult } from "./indexer";
import { runMcpServer } from "./mcp";
import { cachedModelBenchmark, formatBenchmarkSpeed, isCatalogModelInstalled, loadCatalogModelFromPath, MODEL_CATALOG, modelDetails, resolveModel, type ModelCatalogEntry } from "./models";
import { searchRegisteredWorkspaces, searchWorkspace } from "./search";
import { evaluateRetrieval, parseRetrievalEvalCorpus } from "./retrieval-eval";
import { addSessionMemory, listSessionMemories, pruneExpiredSessionMemories, sessionMemorySource } from "./session-memory";
import { KBX_VERSION } from "./version";
import { watchIngest } from "./watch";
import { generateAdapterConfig, generateAdapterHooks, listAdapters } from "./adapters";
import { handleClaudeCodePostToolUse, handleFileRefreshHook } from "./hooks";
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
    }
    console.log(`Indexed ${result.files} file(s), ${result.chunks} new chunk(s), ${result.skipped} skipped/unchanged file(s), ${result.deleted} deleted file(s).`);

    if (options.watch === true) {
      await watchIngest(workspace, absoluteTarget);
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
  .option("--reranker <mode>", "optional reranker mode: none, local, model, or command", "none")
  .option("--reranker-model <model>", "Transformers.js feature-extraction model for --reranker model")
  .option("--reranker-command <command>", "external reranker command that reads JSON from stdin and writes scores JSON")
  .addHelpText("after", `

Examples:
  $ kbx search "deployment notes"
  $ kbx search "workspace registry" -k 10
  $ kbx search "new ADR" --fresh
  $ kbx search "session timeout" --global
  $ kbx search "auth timeout" --reranker model
  $ kbx search "auth timeout" --reranker command --reranker-command "node rerank.mjs"

Search reads the existing index by default. Use --fresh to refresh sources before querying.
Model or LLM reranking is optional and off by default.
`)
  .action(async (query: string, options: { topK: number; fresh?: boolean; global?: boolean; reranker: "none" | "local" | "model" | "command"; rerankerModel?: string; rerankerCommand?: string }) => {
    if (options.global === true) {
      const hits = await searchRegisteredWorkspaces(query, options.topK, {
        reranker: {
          mode: options.reranker,
          model: options.rerankerModel,
          command: options.rerankerCommand
        }
      });
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

    if (options.fresh === true) {
      const freshness = await refreshWorkspaceFreshness(workspace);
      if (freshness.refreshed && freshness.refresh) {
        console.error(`Refreshed ${freshness.refresh.files} file(s), ${freshness.refresh.chunks} new chunk(s), ${freshness.refresh.skipped} skipped/unchanged, ${freshness.refresh.deleted} deleted.`);
      }
    }

    const hits = await searchWorkspace(workspace, query, options.topK, {
      reranker: {
        mode: options.reranker,
        model: options.rerankerModel,
        command: options.rerankerCommand
      }
    });
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
  .command("watch")
  .description("Keep the current workspace index fresh while files change.")
  .summary("Watch manifest sources and refresh changed or deleted files during agent sessions.")
  .argument("[path]", "workspace file or directory to watch")
  .addHelpText("after", `

Examples:
  $ kbx watch
  $ kbx watch docs

This is equivalent to a long-running hot ingest loop. Press Ctrl+C to stop.
`)
  .action(async (targetPath: string | undefined) => {
    const workspace = await requireWorkspace();
    await watchIngest(workspace, targetPath ? path.resolve(targetPath) : undefined);
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
  $ kbx config set init.root_preference git-root --global

Keys:
  chunk.size, chunk.overlap, chunk.strategy (heading|fixed|sentence), mcp.citations, mcp.destructive_tools
  init.root_preference (--global)
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
      await saveConfig(workspace, setConfigValue(config, key, value));
      console.log(`${key}=${value}`);
      return;
    }

    throw new Error("Config action must be get or set.");
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
  $ kbx memory prune

Session memory stores compact notes under .kbx/sessions and indexes them only after explicit retention is provided.
`);

memoryCommand
  .command("add")
  .description("Add a compact session memory note and index it.")
  .argument("<text>", "compact summary or event to remember")
  .option("--title <title>", "short memory title")
  .requiredOption("--retention-days <days>", "number of days before this memory expires", parsePositiveInteger)
  .action(async (text: string, options: { title?: string; retentionDays: number }) => {
    const workspace = await requireWorkspace();
    const { entry, source } = await addSessionMemory(workspace, {
      text,
      title: options.title,
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
      console.log(`${entry.id.slice(0, 8)}  ${entry.title}  expires ${entry.expires_at}`);
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
      const repair = await refreshWorkspaceIndex(workspace);
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
      await rebuildWorkspaceIndexForModel(workspace, nextManifest, sources);
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
}

function createIngestProgress(): CliIngestProgress | undefined {
  if (process.stderr.isTTY !== true) {
    return undefined;
  }

  let spin: SpinnerResult | null = null;
  let bar: ProgressResult | null = null;
  let advancedFiles = 0;
  let spinStarted = false;

  const activeSpinner = () => {
    spin ??= spinner({ output: process.stderr });
    return spin;
  };

  const startOrUpdateSpinner = (message: string) => {
    const current = activeSpinner();
    if (spinStarted) {
      current.message(message);
      return;
    }
    current.start(message);
    spinStarted = true;
  };

  const onProgress = (event: IngestProgressEvent) => {
    switch (event.phase) {
      case "prepare": {
        startOrUpdateSpinner(`Preparing ${shortPath(event.target)}...`);
        return;
      }
      case "scan-start": {
        startOrUpdateSpinner(`Scanning ${event.source}...`);
        return;
      }
      case "scan-complete": {
        if (event.totalFiles === 0) {
          spin?.stop(`No indexable files found in ${event.source}.`);
          spin = null;
          spinStarted = false;
          return;
        }

        spin?.stop(`Found ${event.totalFiles} indexable file(s).`);
        spin = null;
        spinStarted = false;
        bar = progress({ max: event.totalFiles, output: process.stderr });
        advancedFiles = 0;
        bar.start(`Indexing 0/${event.totalFiles} file(s)`);
        return;
      }
      case "delete": {
        bar?.message(`Cleaning deleted files (${event.deletedFiles})...`);
        return;
      }
      case "file": {
        if (!bar) {
          return;
        }
        const step = event.processedFiles - advancedFiles;
        advancedFiles = event.processedFiles;
        const message = ingestProgressMessage(event);
        if (step > 0) {
          bar.advance(step, message);
        } else {
          bar.message(message);
        }
        return;
      }
      case "complete": {
        if (bar) {
          const remaining = event.totalFiles - advancedFiles;
          if (remaining > 0) {
            bar.advance(remaining, ingestCompleteMessage(event));
          }
          bar.stop(ingestCompleteMessage(event));
          bar = null;
        } else {
          spin?.stop(ingestCompleteMessage(event));
          spin = null;
          spinStarted = false;
        }
        return;
      }
    }
  };

  return {
    onProgress,
    error: () => {
      bar?.error("Ingest failed.");
      bar = null;
      spin?.error("Ingest failed.");
      spin = null;
      spinStarted = false;
    }
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

async function requireWorkspace() {
  const workspace = await findWorkspace(process.cwd());
  if (!workspace) {
    throw new Error("No kbx workspace found. Run kbx init first.");
  }
  return workspace;
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

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
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
