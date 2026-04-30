#!/usr/bin/env node
import { confirm, isCancel } from "@clack/prompts";
import { Command } from "commander";
import path from "node:path";
import { getConfigValue, listConfigValues, setConfigValue } from "./config.js";
import { runDoctor } from "./doctor.js";
import { directorySizeBytes, formatBytes } from "./io.js";
import { ingestWorkspaceTarget, loadIndexStats, removeSource, resetWorkspaceIndex } from "./indexer.js";
import { runMcpServer } from "./mcp.js";
import { MODEL_CATALOG, resolveModel } from "./models.js";
import { searchWorkspace } from "./search.js";
import {
  deleteWorkspaceKnowledgeBase,
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
} from "./workspace.js";
import { ChunkVectorStore } from "./vector-store.js";

const program = new Command();

program
  .name("kbx")
  .description("Local-first knowledge base CLI for searchable AI context.")
  .version("0.1.0");

program
  .command("init")
  .description("Create .kbx/ for the current workspace.")
  .argument("[path]", "workspace root", ".")
  .action(async (targetPath: string) => {
    const workspace = await initWorkspace(path.resolve(targetPath));
    const manifest = await loadManifest(workspace);
    console.log(`Initialized ${manifest.name} (${manifest.workspace_id.slice(0, 8)})`);
    console.log(workspace.kbxDir);
  });

program
  .command("ingest")
  .description("Index text-like files in this workspace.")
  .argument("[path]", "workspace path to ingest", ".")
  .action(async (targetPath: string) => {
    const workspace = await findWorkspace(process.cwd()) ?? await maybeInitWorkspace();
    if (!workspace) {
      throw new Error("No kbx workspace found. Run kbx init first.");
    }

    const absoluteTarget = path.resolve(targetPath);
    const result = await ingestWorkspaceTarget(workspace, absoluteTarget);
    console.log(`Indexed ${result.files} file(s), ${result.chunks} new chunk(s), ${result.skipped} unchanged file(s), ${result.deleted} deleted file(s).`);
  });

program
  .command("search")
  .description("Retrieve top chunks from the current workspace.")
  .argument("<query>", "search query")
  .option("-k, --top-k <number>", "number of chunks to return", parsePositiveInteger, 5)
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
  .action(async () => {
    const workspace = await requireWorkspace();
    await runMcpServer(workspace);
  });

program
  .command("config")
  .description("View or edit workspace config.")
  .argument("<action>", "get or set")
  .argument("[key]", "config key")
  .argument("[value]", "config value")
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
  .action(async () => {
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
    console.log(`Registry: ${registryPath()}`);
  });

program
  .command("reset")
  .description("Clear current workspace index, preserving config and identity.")
  .option("-y, --yes", "skip confirmation")
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
  .description("Manage registered workspaces.");

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
  .description("Manage ingest sources.");

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
  .action(async (selector: string, options: { yes?: boolean }) => {
    const workspace = await requireWorkspace();
    const ok = options.yes === true || await confirmAction(`Remove source "${selector}" and its indexed chunks?`);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }

    const result = await removeSource(workspace, selector);
    console.log(`Removed source ${result.source}; deleted chunks for ${result.removedFiles} file(s).`);
  });

program
  .command("doctor")
  .description("Diagnose environment and workspace health.")
  .option("--fresh", "scan source files for stale/deleted/new files")
  .option("--bench", "run a small local embedding benchmark")
  .option("--deep", "include freshness scan and benchmark")
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
  .description("Inspect and change embedding models.");

modelCommand
  .command("list")
  .description("List supported embedding models.")
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
  .command("use")
  .description("Select a supported embedding model.")
  .argument("<model-id>", "catalog model ID")
  .option("--reindex", "reset and rebuild from sources after switching")
  .option("-y, --yes", "skip confirmation")
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
    await saveManifest(workspace, {
      ...manifest,
      model: model.model,
      dim: model.dim,
      updated_at: new Date().toISOString()
    });
    await resetWorkspaceIndex(workspace);

    if (options.reindex === true) {
      for (const source of sources) {
        await ingestWorkspaceTarget(workspace, path.resolve(workspace.root, source.path));
      }
    }

    console.log(`Selected model ${model.id} (${model.dim}d).`);
  });

program.exitOverride();

program.parseAsync().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});

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
