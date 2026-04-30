#!/usr/bin/env node
import { confirm, isCancel } from "@clack/prompts";
import { Command } from "commander";
import path from "node:path";
import { ingestWorkspaceTarget } from "./indexer.js";
import { searchWorkspace } from "./search.js";
import { findWorkspace, initWorkspace, loadManifest, registryPath, workspaceFromRoot } from "./workspace.js";

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
  .description("Index markdown files in this workspace.")
  .argument("[path]", "workspace path to ingest", ".")
  .action(async (targetPath: string) => {
    const workspace = await findWorkspace(process.cwd()) ?? await maybeInitWorkspace();
    if (!workspace) {
      throw new Error("No kbx workspace found. Run kbx init first.");
    }

    const absoluteTarget = path.resolve(targetPath);
    const result = await ingestWorkspaceTarget(workspace, absoluteTarget);
    console.log(`Indexed ${result.files} markdown file(s), ${result.chunks} new chunk(s), ${result.skipped} unchanged file(s).`);
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
  .command("stats")
  .description("Show basic workspace metadata.")
  .action(async () => {
    const workspace = await findWorkspace(process.cwd());
    if (!workspace) {
      throw new Error("No kbx workspace found. Run kbx init first.");
    }
    const manifest = await loadManifest(workspace);
    console.log(`Workspace: ${manifest.name} (${manifest.workspace_id.slice(0, 8)})`);
    console.log(`Model: ${manifest.model} (${manifest.dim}d)`);
    console.log(`Registry: ${registryPath()}`);
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
