#!/usr/bin/env node
import { confirm, isCancel } from "@clack/prompts";
import { Command } from "commander";
import path from "node:path";
import { getConfigValue, listConfigValues, setConfigValue } from "./config";
import { benchmarkLine, freshnessLine, runDoctor } from "./doctor";
import { directorySizeBytes, formatBytes } from "./io";
import { ingestSource, ingestWorkspaceTarget, loadIndexStats, rebuildWorkspaceIndexForModel, removeSource, resetWorkspaceIndex, resolveSourceEntry } from "./indexer";
import { runMcpServer } from "./mcp";
import { MODEL_CATALOG, resolveModel } from "./models";
import { searchWorkspace } from "./search";
import { watchIngest } from "./watch";
import {
  deleteWorkspaceKnowledgeBase,
  findGitRoot,
  findWorkspace,
  forgetWorkspace,
  initWorkspace,
  loadConfig,
  loadManifest,
  loadRegistry,
  loadSources,
  registryPath,
  saveConfig,
  saveManifest,
  workspaceFromRoot
} from "./workspace";
import { ChunkVectorStore } from "./vector-store";

const program = new Command();

program
  .name("kbx")
  .description("Local-first knowledge base CLI for searchable AI context.")
  .summary("Index a workspace into .kbx/ and retrieve local chunks for AI assistants.")
  .version("0.1.0")
  .showHelpAfterError()
  .addHelpText("after", `

Common workflows:
  $ kbx init --model nomic
  $ kbx ingest
  $ kbx search "workspace registry" -k 5
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
  .action(async (targetPath: string, options: { here?: boolean; gitRoot?: boolean; model?: string }) => {
    const root = await resolveInitRoot(targetPath, options);
    const model = options.model ? resolveModel(options.model) : undefined;
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
    const result = await ingestWorkspaceTarget(workspace, absoluteTarget, {
      allowExternal: options.allowExternal,
      include: options.include,
      exclude: options.exclude,
      noGitignore: options.gitignore === false
    });
    console.log(`Indexed ${result.files} file(s), ${result.chunks} new chunk(s), ${result.skipped} unchanged file(s), ${result.deleted} deleted file(s).`);

    if (options.watch === true) {
      await watchIngest(workspace);
    }
  });

program
  .command("search")
  .description("Retrieve top chunks from the current workspace.")
  .summary("Run semantic retrieval against the nearest initialized workspace.")
  .argument("<query>", "search query")
  .option("-k, --top-k <number>", "number of chunks to return", parsePositiveInteger, 5)
  .addHelpText("after", `

Examples:
  $ kbx search "deployment notes"
  $ kbx search "workspace registry" -k 10

Search reads the existing index only. Use kbx stats --fresh to check staleness.
`)
  .action(async (query: string, options: { topK: number }) => {
    const workspace = await findWorkspace(process.cwd());
    if (!workspace) {
      throw new Error("No kbx workspace found. Run kbx init first.");
    }

    const hits = await searchWorkspace(workspace, query, options.topK);
    if (hits.length === 0) {
      console.log("No results.");
      return;
    }

    for (const [index, hit] of hits.entries()) {
      console.log(`${index + 1}. ${hit.source}#${hit.chunk_idx} (${hit.score.toFixed(3)})`);
      console.log(indent(excerpt(hit.text)));
      console.log("");
    }
  });

program
  .command("mcp")
  .description("Run the MCP server over stdio.")
  .summary("Expose read-only kbx search tools to MCP clients.")
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

program
  .command("config")
  .description("View or edit workspace config.")
  .summary("Read or change workspace-local kbx settings.")
  .argument("<action>", "get or set")
  .argument("[key]", "config key")
  .argument("[value]", "config value")
  .addHelpText("after", `

Examples:
  $ kbx config get
  $ kbx config get chunk.size
  $ kbx config set chunk.size 1200
  $ kbx config set mcp.citations full-path

Keys:
  chunk.size, chunk.overlap, chunk.strategy, mcp.citations
`)
  .action(async (action: string, key?: string, value?: string) => {
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

program
  .command("doctor")
  .description("Diagnose environment and workspace health.")
  .summary("Check workspace, platform, registry, collection, model, and optional freshness/benchmarks.")
  .option("--fresh", "scan source files for stale/deleted/new files")
  .option("--bench", "run a small local embedding benchmark")
  .option("--deep", "include freshness scan and benchmark")
  .addHelpText("after", `

Examples:
  $ kbx doctor
  $ kbx doctor --fresh
  $ kbx doctor --deep
`)
  .action(async (options: { fresh?: boolean; bench?: boolean; deep?: boolean }) => {
    const workspace = await findWorkspace(process.cwd());
    const lines = await runDoctor(workspace, {
      fresh: options.fresh === true || options.deep === true,
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
  $ kbx model use minilm --reindex
`);

modelCommand
  .command("list")
  .description("List supported embedding models.")
  .summary("Show catalog IDs, dimensions, size estimates, and selected model.")
  .action(async () => {
    const workspace = await findWorkspace(process.cwd());
    const currentModel = workspace ? (await loadManifest(workspace)).model : "";
    console.log("ID          Size      Dim   Profile    Selected  Description");
    for (const model of MODEL_CATALOG) {
      const selected = model.model === currentModel ? "yes" : "no";
      console.log(`${model.id.padEnd(11)} ${model.size.padEnd(9)} ${String(model.dim).padEnd(5)} ${model.profile.padEnd(10)} ${selected.padEnd(9)} ${model.description}`);
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
  .command("use")
  .description("Select a supported embedding model.")
  .summary("Switch model selection; use --reindex when indexed content exists.")
  .argument("<model-id>", "catalog model ID")
  .option("--reindex", "reset and rebuild from sources after switching")
  .option("-y, --yes", "skip confirmation")
  .addHelpText("after", `

Examples:
  $ kbx model use minilm
  $ kbx model use nomic --reindex
  $ kbx model use bge-base --reindex --yes

When indexed content exists, kbx rebuilds into a temporary index before swapping it in.
`)
  .action(async (modelId: string, options: { reindex?: boolean; yes?: boolean }) => {
    const workspace = await requireWorkspace();
    const model = resolveModel(modelId);
    const manifest = await loadManifest(workspace);
    if (manifest.model === model.model && manifest.dim === model.dim) {
      console.log(`Model already selected: ${model.id}`);
      return;
    }

    const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
    const hasIndex = Object.keys(stats.files).length > 0;
    if (hasIndex && options.reindex !== true) {
      throw new Error("Switching models requires rebuilding vectors. Re-run with --reindex.");
    }

    if (hasIndex) {
      const ok = options.yes === true || await confirmAction(`Switch to ${model.id} and rebuild the current workspace index?`);
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
  return path.resolve(targetPath);
}

function modelLabel(modelName: string): string {
  return MODEL_CATALOG.find((entry) => entry.model === modelName)?.id ?? modelName;
}

async function maybeInitWorkspace() {
  if (!process.stdin.isTTY) {
    return null;
  }

  const shouldInit = await confirm({
    message: "No kbx workspace found. Initialize one here?",
    initialValue: true
  });
  if (isCancel(shouldInit) || shouldInit !== true) {
    return null;
  }
  return initWorkspace(workspaceFromRoot(process.cwd()).root);
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
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Expected a positive integer");
  }
  return parsed;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
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
