#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { extractIndexableText } from "../src/document-text";
import { listIndexableFileEntries } from "../src/files";
import { directorySizeBytes, formatBytes, readJson, writeJson } from "../src/io";
import { ingestSource, resetWorkspaceIndex } from "../src/indexer";
import { resolveModel } from "../src/models";
import { searchWorkspace } from "../src/search";
import {
  DEFAULT_MODEL_DIM,
  DEFAULT_MODEL_ID,
  SCHEMA_VERSION,
  type SearchHit,
  type SourceEntry,
  type WorkspaceManifest
} from "../src/types";
import { defaultConfig, type Workspace } from "../src/workspace";

interface Args {
  roots: string[];
  out: string;
  variants: string[];
  queries: string[];
  projects?: string[];
  include: string[];
  exclude: string[];
  topK: number;
  limit?: number;
  projectTimeoutMs: number;
  maxProjectBytes?: number;
  maxProjectFiles?: number;
  minProjectFiles?: number;
  deepInventory: boolean;
  keepIndexes: boolean;
  clean: boolean;
  workerInput?: string;
  workerOutput?: string;
}

interface Project {
  name: string;
  path: string;
}

interface VariantSpec {
  id: string;
  model: string;
  dim: number;
  embedder: "hash" | "model";
  reranker?: {
    mode: "model";
    model: string;
  };
}

interface ProjectInventory {
  files: number;
  bytes: number;
  extractedChars: number;
  fullContextTokens: number;
  inventoryMs: number;
}

interface QueryMetric {
  query: string;
  searchMs: number;
  hits: number;
  contextChars: number;
  contextTokens: number;
  contextSavingsPct: number;
  topScore: number;
  matchBreakdown: Record<string, number>;
  topSources: string[];
}

interface VariantMetric {
  variant: string;
  model: string;
  dim: number;
  embedder: "hash" | "model";
  reranker?: VariantSpec["reranker"];
  ingestMs: number;
  indexBytes: number;
  files: number;
  chunks: number;
  skipped: number;
  deleted: number;
  queries: QueryMetric[];
  averages: {
    searchMs: number;
    contextTokens: number;
    contextSavingsPct: number;
    topScore: number;
  };
  error?: string;
}

interface ProjectMetric {
  name: string;
  path: string;
  inventory: ProjectInventory;
  variants: VariantMetric[];
  skippedReason?: string;
}

interface SummaryVariant {
  variant: string;
  projects: number;
  failures: number;
  ingestMs: number;
  indexBytes: number;
  chunks: number;
  avgSearchMs: number;
  avgContextTokens: number;
  avgContextSavingsPct: number;
  avgTopScore: number;
}

interface BenchmarkReport {
  schema_version: 1;
  status: "running" | "completed";
  started_at: string;
  completed_at: string | null;
  roots: string[];
  top_k: number;
  deep_inventory: boolean;
  project_timeout_ms: number;
  include: string[];
  exclude: string[];
  queries: string[];
  variants: Array<{
    id: string;
    model: string;
    dim: number;
    embedder: "hash" | "model";
    reranker?: VariantSpec["reranker"];
  }>;
  projects: ProjectMetric[];
  summary: {
    projects: number;
    skippedProjects: number;
    inventory: {
      files: number;
      bytes: number;
      fullContextTokens: number;
    };
    variants: SummaryVariant[];
  };
}

interface WorkerInput {
  project: Project;
  variant: VariantSpec;
  inventory: ProjectInventory;
  indexRoot: string;
  queries: string[];
  include: string[];
  exclude: string[];
  topK: number;
}

const args = parseArgs(process.argv.slice(2));

if (args.workerInput && args.workerOutput) {
  await runWorker(args.workerInput, args.workerOutput);
} else {
  await runParent(args);
}

async function runParent(options: Args): Promise<void> {
  const startedAt = new Date().toISOString();
  const outDir = path.resolve(options.out);
  const indexRoot = path.join(outDir, "indexes");
  const workerRoot = path.join(outDir, "workers");

  if (options.clean) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(workerRoot, { recursive: true });

  const projects = (await discoverProjects(options.roots, options.projects)).slice(0, options.limit);
  const variants = options.variants.map(resolveVariant);
  const results: ProjectMetric[] = [];

  console.log(`Benchmarking ${projects.length} project(s), ${variants.length} variant(s), ${options.queries.length} queries.`);
  console.log(`Report directory: ${outDir}`);
  console.log(`Per-variant timeout: ${formatDuration(options.projectTimeoutMs)}`);

  await writeReport(outDir, startedAt, options, variants, results, "running");

  for (const [projectIndex, project] of projects.entries()) {
    console.log(`\n[${projectIndex + 1}/${projects.length}] ${project.name}`);
    const inventory = await measureInventory(project.path, options.deepInventory, options.include, options.exclude);
    console.log(`  inventory: ${inventory.files} file(s), ${formatBytes(inventory.bytes)}, ~${inventory.fullContextTokens.toLocaleString()} tokens`);

    const projectMetric: ProjectMetric = {
      name: project.name,
      path: project.path,
      inventory,
      variants: []
    };
    results.push(projectMetric);

    const skippedReason = skipReason(inventory, options);
    if (skippedReason) {
      projectMetric.skippedReason = skippedReason;
      console.log(`  skipped: ${skippedReason}`);
      await writeReport(outDir, startedAt, options, variants, results, "running");
      continue;
    }

    for (const variant of variants) {
      console.log(`  ${variant.id}: indexing/searching...`);
      const metric = await runVariantWorker({
        project,
        variant,
        inventory,
        indexRoot,
        queries: options.queries,
        include: options.include,
        exclude: options.exclude,
        topK: options.topK
      }, workerRoot, options.projectTimeoutMs);
      projectMetric.variants.push(metric);
      await writeReport(outDir, startedAt, options, variants, results, "running");
    }
  }

  await writeReport(outDir, startedAt, options, variants, results, "completed");

  if (!options.keepIndexes) {
    await rm(indexRoot, { recursive: true, force: true });
    await rm(workerRoot, { recursive: true, force: true });
  }

  console.log(`\nWrote ${path.join(outDir, "report.json")}`);
  console.log(`Wrote ${path.join(outDir, "report.md")}`);
}

async function runWorker(inputPath: string, outputPath: string): Promise<void> {
  const input = await readJson<WorkerInput>(path.resolve(inputPath));
  const metric = await measureVariant(input);
  await writeJson(path.resolve(outputPath), metric);
}

async function runVariantWorker(input: WorkerInput, workerRoot: string, timeoutMs: number): Promise<VariantMetric> {
  await mkdir(workerRoot, { recursive: true });
  const workerId = `${safePathSegment(input.project.name)}-${safePathSegment(input.variant.id)}-${Date.now()}`;
  const inputPath = path.join(workerRoot, `${workerId}.input.json`);
  const outputPath = path.join(workerRoot, `${workerId}.output.json`);
  await writeJson(inputPath, input);

  const result = await runProcess(process.execPath, [
    "--import",
    "tsx",
    scriptPath(),
    "--worker-input",
    inputPath,
    "--worker-output",
    outputPath
  ], timeoutMs);

  if (result.timedOut) {
    return failedVariant(input.variant, `Timed out after ${formatDuration(timeoutMs)}.`);
  }
  if (result.code !== 0) {
    return failedVariant(input.variant, `Worker exited with ${result.code}: ${result.stderr.trim()}`);
  }

  try {
    return await readJson<VariantMetric>(outputPath);
  } catch (error) {
    return failedVariant(input.variant, `Worker did not write a valid result: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(values: string[]): Args {
  const parsed: Args = {
    roots: ["D:\\Work", "D:\\Work\\Joodlab"],
    out: path.join(process.cwd(), ".kbx-bench", timestampForPath(new Date())),
    variants: ["hash", "minilm"],
    projects: undefined,
    include: [],
    exclude: [],
    queries: [
      "project setup installation dependencies",
      "application architecture main implementation",
      "configuration environment variables",
      "tests build scripts",
      "deployment database api integration"
    ],
    topK: 5,
    projectTimeoutMs: 15 * 60 * 1000,
    deepInventory: false,
    keepIndexes: false,
    clean: false
  };

  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index]!;
    const next = () => {
      const value = values[++index];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    switch (arg) {
      case "--roots":
        parsed.roots = splitList(next());
        break;
      case "--out":
        parsed.out = next();
        break;
      case "--variants":
      case "--models":
        parsed.variants = splitList(next());
        break;
      case "--queries":
        parsed.queries = splitList(next());
        break;
      case "--projects":
        parsed.projects = splitList(next());
        break;
      case "--include":
        parsed.include.push(...splitList(next()));
        break;
      case "--exclude":
        parsed.exclude.push(...splitList(next()));
        break;
      case "--top-k":
      case "-k":
        parsed.topK = parsePositiveInteger(next(), arg);
        break;
      case "--limit":
        parsed.limit = parsePositiveInteger(next(), arg);
        break;
      case "--project-timeout-ms":
        parsed.projectTimeoutMs = parsePositiveInteger(next(), arg);
        break;
      case "--project-timeout-minutes":
        parsed.projectTimeoutMs = parsePositiveInteger(next(), arg) * 60 * 1000;
        break;
      case "--max-project-mb":
        parsed.maxProjectBytes = parsePositiveInteger(next(), arg) * 1024 * 1024;
        break;
      case "--max-project-files":
        parsed.maxProjectFiles = parsePositiveInteger(next(), arg);
        break;
      case "--min-project-files":
        parsed.minProjectFiles = parsePositiveInteger(next(), arg);
        break;
      case "--keep-indexes":
        parsed.keepIndexes = true;
        break;
      case "--deep-inventory":
        parsed.deepInventory = true;
        break;
      case "--clean":
        parsed.clean = true;
        break;
      case "--worker-input":
        parsed.workerInput = next();
        break;
      case "--worker-output":
        parsed.workerOutput = next();
        break;
      case "--query-file":
        throw new Error("--query-file is not supported in this script yet; use --queries.");
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/benchmark-projects.ts [options]

Options:
  --roots <paths>                  Comma-separated parent folders to scan. Default: D:\\Work,D:\\Work\\Joodlab
  --out <dir>                      Output directory. Default: .kbx-bench/<timestamp>
  --variants <list>                Comma-separated variants: hash,minilm,nomic,hash-rerank-minilm.
  --projects <list>                Comma-separated project names or full paths to benchmark.
  --include <globs>                Comma-separated include globs; can be repeated.
  --exclude <globs>                Comma-separated exclude globs; can be repeated.
  --queries <list>                 Comma-separated benchmark queries.
  -k, --top-k <n>                  Retrieved chunks per query. Default: 5
  --limit <n>                      Benchmark only the first n discovered projects.
  --project-timeout-minutes <n>    Timeout each project/variant worker. Default: 15
  --max-project-mb <n>             Skip projects with more indexable bytes than this.
  --max-project-files <n>          Skip projects with more indexable files than this.
  --min-project-files <n>          Skip projects with fewer indexable files than this.
  --deep-inventory                 Extract all indexable text before ingest for a closer no-kbx estimate.
  --keep-indexes                   Keep generated benchmark indexes under the output directory.
  --clean                          Remove --out before running.
`);
}

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function discoverProjects(roots: string[], selectors: string[] | undefined): Promise<Project[]> {
  const byPath = new Map<string, Project>();
  for (const root of roots.map((entry) => path.resolve(entry))) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const projectPath = path.join(root, entry.name);
      if (path.resolve(projectPath) === path.resolve(process.cwd())) {
        continue;
      }
      if (projectPath.toLowerCase() === path.resolve("D:\\Work\\Joodlab").toLowerCase()) {
        continue;
      }
      byPath.set(projectPath.toLowerCase(), {
        name: entry.name,
        path: projectPath
      });
    }
  }

  const discovered = [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!selectors || selectors.length === 0) {
    return discovered;
  }

  const selected: Project[] = [];
  for (const selector of selectors) {
    const selectorPath = path.resolve(selector).toLowerCase();
    const match = discovered.find((project) => (
      project.name === selector
      || project.path.toLowerCase() === selector.toLowerCase()
      || project.path.toLowerCase() === selectorPath
    ));
    if (!match) {
      throw new Error(`No discovered project matches "${selector}".`);
    }
    selected.push(match);
  }
  return selected;
}

function resolveVariant(id: string): VariantSpec {
  if (id === "hash") {
    return {
      id,
      model: DEFAULT_MODEL_ID,
      dim: DEFAULT_MODEL_DIM,
      embedder: "hash"
    };
  }

  if (id === "hash-rerank" || id === "hash+rerank" || id.startsWith("hash-rerank-")) {
    const rerankerId = id.startsWith("hash-rerank-") ? id.slice("hash-rerank-".length) : "minilm";
    const reranker = resolveModel(rerankerId);
    return {
      id: `hash-rerank-${reranker.id}`,
      model: DEFAULT_MODEL_ID,
      dim: DEFAULT_MODEL_DIM,
      embedder: "hash",
      reranker: {
        mode: "model",
        model: reranker.model
      }
    };
  }

  const catalog = resolveModel(id);
  return {
    id: catalog.id,
    model: catalog.model,
    dim: catalog.dim,
    embedder: "model"
  };
}

async function measureInventory(projectPath: string, deepInventory: boolean, include: string[] = [], exclude: string[] = []): Promise<ProjectInventory> {
  const start = performance.now();
  const files = await listIndexableFileEntries(projectPath, ".", { include, exclude, useGitignore: true });
  let bytes = 0;
  let extractedChars = 0;
  for (const file of files) {
    const info = await stat(file.absolutePath);
    bytes += info.size;
    if (deepInventory) {
      try {
        const text = await extractIndexableText(file.absolutePath, file.extension);
        extractedChars += text.length;
      } catch {
        // Keep inventory robust; ingest reports variant failures if a file breaks indexing.
      }
    }
  }

  return {
    files: files.length,
    bytes,
    extractedChars,
    fullContextTokens: estimateTokens(extractedChars > 0 ? extractedChars : bytes),
    inventoryMs: Math.round(performance.now() - start)
  };
}

async function measureVariant(input: WorkerInput): Promise<VariantMetric> {
  const { project, variant, inventory, indexRoot, queries, include, exclude, topK } = input;
  const workspace = workspaceFor(project, variant, indexRoot);
  await rm(workspace.kbxDir, { recursive: true, force: true });
  await mkdir(workspace.kbxDir, { recursive: true });
  const manifest: WorkspaceManifest = {
    workspace_id: crypto.createHash("sha256").update(`${project.path}:${variant.id}`).digest("hex").slice(0, 24),
    name: project.name,
    model: variant.model,
    dim: variant.dim,
    schema_version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const source: SourceEntry = {
    kind: "workspace",
    path: ".",
    include,
    exclude
  };
  await writeJson(workspace.manifestPath, manifest);
  await writeJson(workspace.configPath, defaultConfig);
  await writeJson(workspace.sourcesPath, [source]);
  await resetWorkspaceIndex(workspace);

  const previousEmbedder = process.env.KBX_EMBEDDER;
  if (variant.embedder === "hash") {
    process.env.KBX_EMBEDDER = "hash";
  } else {
    delete process.env.KBX_EMBEDDER;
  }

  try {
    const ingestStart = performance.now();
    const ingest = await ingestSource(workspace, source);
    const ingestMs = Math.round(performance.now() - ingestStart);
    const indexBytes = await directorySizeBytes(workspace.kbxDir);
    const queryMetrics: QueryMetric[] = [];

    for (const query of queries) {
      const queryStart = performance.now();
      const hits = await searchWorkspace(workspace, query, topK, {
        reranker: variant.reranker
          ? {
              mode: variant.reranker.mode,
              model: variant.reranker.model
            }
          : undefined
      });
      queryMetrics.push(queryMetric(query, hits, performance.now() - queryStart, inventory));
    }

    return {
      variant: variant.id,
      model: variant.model,
      dim: variant.dim,
      embedder: variant.embedder,
      reranker: variant.reranker,
      ingestMs,
      indexBytes,
      files: ingest.files,
      chunks: ingest.chunks,
      skipped: ingest.skipped,
      deleted: ingest.deleted,
      queries: queryMetrics,
      averages: averageQueryMetrics(queryMetrics)
    };
  } catch (error) {
    return {
      ...failedVariant(variant, error instanceof Error ? error.message : String(error)),
      indexBytes: await directorySizeBytes(workspace.kbxDir)
    };
  } finally {
    if (previousEmbedder === undefined) {
      delete process.env.KBX_EMBEDDER;
    } else {
      process.env.KBX_EMBEDDER = previousEmbedder;
    }
  }
}

function workspaceFor(project: Project, variant: VariantSpec, root: string): Workspace {
  const safeName = `${project.name}-${variant.id}`.replace(/[^a-z0-9_.-]+/gi, "_");
  const kbxDir = path.join(root, safeName);
  return {
    root: project.path,
    kbxDir,
    manifestPath: path.join(kbxDir, "manifest.json"),
    configPath: path.join(kbxDir, "config.json"),
    sourcesPath: path.join(kbxDir, "sources.json"),
    statsPath: path.join(kbxDir, "stats.json"),
    lexicalPath: path.join(kbxDir, "lexical.db"),
    collectionDir: path.join(kbxDir, "collection")
  };
}

function queryMetric(query: string, hits: SearchHit[], elapsedMs: number, inventory: ProjectInventory): QueryMetric {
  const contextChars = hits.reduce((sum, hit) => sum + hit.text.length, 0);
  const topScore = hits[0]?.score ?? 0;
  const matchBreakdown: Record<string, number> = {};
  for (const hit of hits) {
    matchBreakdown[hit.match] = (matchBreakdown[hit.match] ?? 0) + 1;
  }

  return {
    query,
    searchMs: Math.round(elapsedMs),
    hits: hits.length,
    contextChars,
    contextTokens: estimateTokens(contextChars),
    contextSavingsPct: percentSaved(inventory.fullContextTokens, estimateTokens(contextChars)),
    topScore,
    matchBreakdown,
    topSources: [...new Set(hits.map((hit) => hit.source))].slice(0, 5)
  };
}

function averageQueryMetrics(queries: QueryMetric[]): VariantMetric["averages"] {
  return {
    searchMs: round(mean(queries.map((query) => query.searchMs)), 1),
    contextTokens: round(mean(queries.map((query) => query.contextTokens)), 1),
    contextSavingsPct: round(mean(queries.map((query) => query.contextSavingsPct)), 2),
    topScore: round(mean(queries.map((query) => query.topScore)), 4)
  };
}

function failedVariant(variant: VariantSpec, error: string): VariantMetric {
  return {
    variant: variant.id,
    model: variant.model,
    dim: variant.dim,
    embedder: variant.embedder,
    reranker: variant.reranker,
    ingestMs: 0,
    indexBytes: 0,
    files: 0,
    chunks: 0,
    skipped: 0,
    deleted: 0,
    queries: [],
    averages: {
      searchMs: 0,
      contextTokens: 0,
      contextSavingsPct: 0,
      topScore: 0
    },
    error
  };
}

function skipReason(inventory: ProjectInventory, options: Args): string | undefined {
  if (options.minProjectFiles !== undefined && inventory.files < options.minProjectFiles) {
    return `indexable file count ${inventory.files} is below --min-project-files ${options.minProjectFiles}`;
  }
  if (options.maxProjectFiles !== undefined && inventory.files > options.maxProjectFiles) {
    return `indexable file count ${inventory.files} exceeds --max-project-files ${options.maxProjectFiles}`;
  }
  if (options.maxProjectBytes !== undefined && inventory.bytes > options.maxProjectBytes) {
    return `indexable bytes ${formatBytes(inventory.bytes)} exceed --max-project-mb ${Math.round(options.maxProjectBytes / 1024 / 1024)}`;
  }
  return undefined;
}

async function writeReport(
  outDir: string,
  startedAt: string,
  options: Args,
  variants: VariantSpec[],
  results: ProjectMetric[],
  status: BenchmarkReport["status"]
): Promise<void> {
  const report = buildReport(startedAt, options, variants, results, status);
  await writeJson(path.join(outDir, "report.json"), report);
  await writeFile(path.join(outDir, "report.md"), renderMarkdown(report), "utf8");
}

function buildReport(
  startedAt: string,
  options: Args,
  variants: VariantSpec[],
  results: ProjectMetric[],
  status: BenchmarkReport["status"]
): BenchmarkReport {
  return {
    schema_version: 1,
    status,
    started_at: startedAt,
    completed_at: status === "completed" ? new Date().toISOString() : null,
    roots: options.roots.map((root) => path.resolve(root)),
    top_k: options.topK,
    deep_inventory: options.deepInventory,
    project_timeout_ms: options.projectTimeoutMs,
    include: options.include,
    exclude: options.exclude,
    queries: options.queries,
    variants: variants.map((variant) => ({
      id: variant.id,
      model: variant.model,
      dim: variant.dim,
      embedder: variant.embedder,
      reranker: variant.reranker
    })),
    projects: results,
    summary: summarize(results)
  };
}

function summarize(results: ProjectMetric[]): BenchmarkReport["summary"] {
  const byVariant = new Map<string, VariantMetric[]>();
  for (const project of results) {
    for (const variant of project.variants) {
      const values = byVariant.get(variant.variant) ?? [];
      values.push(variant);
      byVariant.set(variant.variant, values);
    }
  }

  return {
    projects: results.length,
    skippedProjects: results.filter((project) => project.skippedReason).length,
    inventory: {
      files: sum(results.map((project) => project.inventory.files)),
      bytes: sum(results.map((project) => project.inventory.bytes)),
      fullContextTokens: sum(results.map((project) => project.inventory.fullContextTokens))
    },
    variants: [...byVariant.entries()].map(([variant, values]) => ({
      variant,
      projects: values.length,
      failures: values.filter((value) => value.error).length,
      ingestMs: round(mean(values.filter((value) => !value.error).map((value) => value.ingestMs)), 1),
      indexBytes: round(mean(values.filter((value) => !value.error).map((value) => value.indexBytes)), 1),
      chunks: round(mean(values.filter((value) => !value.error).map((value) => value.chunks)), 1),
      avgSearchMs: round(mean(values.filter((value) => !value.error).map((value) => value.averages.searchMs)), 1),
      avgContextTokens: round(mean(values.filter((value) => !value.error).map((value) => value.averages.contextTokens)), 1),
      avgContextSavingsPct: round(mean(values.filter((value) => !value.error).map((value) => value.averages.contextSavingsPct)), 2),
      avgTopScore: round(mean(values.filter((value) => !value.error).map((value) => value.averages.topScore)), 4)
    }))
  };
}

function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push("# KBX Project Benchmark");
  lines.push("");
  lines.push(`Status: ${report.status}`);
  lines.push(`Started: ${report.started_at}`);
  lines.push(`Completed: ${report.completed_at ?? "not yet"}`);
  lines.push(`Projects: ${report.summary.projects} (${report.summary.skippedProjects} skipped)`);
  lines.push(`Top-k: ${report.top_k}`);
  lines.push(`Per-variant timeout: ${formatDuration(report.project_timeout_ms)}`);
  if (report.include.length > 0) {
    lines.push(`Include: ${report.include.join(", ")}`);
  }
  if (report.exclude.length > 0) {
    lines.push(`Exclude: ${report.exclude.join(", ")}`);
  }
  lines.push("");
  lines.push("## Variant Summary");
  lines.push("");
  lines.push("| Variant | Failures | Avg ingest | Avg search | Avg ctx tokens | Avg saved | Avg chunks | Avg index | Avg top score |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.summary.variants) {
    lines.push(`| ${row.variant} | ${row.failures}/${row.projects} | ${formatDuration(row.ingestMs)} | ${formatDuration(row.avgSearchMs)} | ${row.avgContextTokens.toLocaleString()} | ${row.avgContextSavingsPct.toFixed(2)}% | ${row.chunks.toLocaleString()} | ${formatBytes(row.indexBytes)} | ${row.avgTopScore.toFixed(4)} |`);
  }
  lines.push("");
  lines.push("## Project Details");
  lines.push("");
  lines.push("| Project | Variant | Files | Full ctx tokens | Chunks | Index | Ingest | Search | Ctx tokens | Saved | Top score |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const project of report.projects) {
    if (project.skippedReason) {
      lines.push(`| ${project.name} | skipped: ${project.skippedReason} | ${project.inventory.files} | ${project.inventory.fullContextTokens.toLocaleString()} | - | - | - | - | - | - | - |`);
      continue;
    }
    for (const variant of project.variants) {
      if (variant.error) {
        lines.push(`| ${project.name} | ${variant.variant}: ${escapePipes(variant.error)} | ${project.inventory.files} | ${project.inventory.fullContextTokens.toLocaleString()} | error | ${formatBytes(variant.indexBytes)} | error | error | error | error | error |`);
        continue;
      }
      lines.push(`| ${project.name} | ${variant.variant} | ${project.inventory.files} | ${project.inventory.fullContextTokens.toLocaleString()} | ${variant.chunks.toLocaleString()} | ${formatBytes(variant.indexBytes)} | ${formatDuration(variant.ingestMs)} | ${formatDuration(variant.averages.searchMs)} | ${variant.averages.contextTokens.toLocaleString()} | ${variant.averages.contextSavingsPct.toFixed(2)}% | ${variant.averages.topScore.toFixed(4)} |`);
    }
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(report.deep_inventory
    ? "- Full context tokens are estimated as one token per four extracted characters."
    : "- Full context tokens are estimated as one token per four indexable-file bytes; pass `--deep-inventory` to estimate from extracted text.");
  lines.push("- Reports are written incrementally after each project/variant, so a stopped run still leaves completed results.");
  lines.push("- `hash-rerank-minilm` indexes with the hash embedder, then reranks retrieved candidates with the MiniLM feature model.");
  lines.push("- Top score is the original retrieval score of the final top hit; for reranker variants, use it as a weak diagnostic rather than a direct quality score.");
  lines.push("- The default queries are generic proxy tasks; use a labeled retrieval corpus for quality claims.");
  return `${lines.join("\n")}\n`;
}

function runProcess(command: string, processArgs: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, processArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({ code: null, stderr: Buffer.concat(stderr).toString("utf8"), timedOut: true });
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr: Buffer.concat(stderr).toString("utf8"), timedOut: false });
    });
  });
}

function scriptPath(): string {
  return path.resolve(process.argv[1] ?? "scripts/benchmark-projects.ts");
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function percentSaved(fullTokens: number, retrievedTokens: number): number {
  if (fullTokens <= 0) {
    return 0;
  }
  return round(Math.max(0, 1 - retrievedTokens / fullTokens) * 100, 2);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "_");
}

function escapePipes(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? 0 : sum(finite) / finite.length;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)}s`;
  }
  return `${Math.round(ms)}ms`;
}
