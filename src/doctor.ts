import { performance } from "node:perf_hooks";
import { generateAllAdapterHooks, validateAllAdapterConfigs } from "./adapters";
import { createEmbedder } from "./embedding";
import { directorySizeBytes, formatBytes } from "./io";
import { loadIndexStats, scanWorkspaceFreshness } from "./indexer";
import { LexicalIndexStore } from "./lexical-index";
import { cachedModelBenchmark, saveModelBenchmarkResult } from "./models";
import type { IndexStats } from "./types";
import {
  loadConfig,
  loadManifest,
  loadRegistry,
  loadSources,
  type Workspace
} from "./workspace";
import { ChunkVectorStore } from "./vector-store";

export interface DoctorOptions {
  fresh?: boolean;
  bench?: boolean;
}

export interface DoctorLine {
  ok: boolean;
  label: string;
  detail: string;
}

export async function runDoctor(workspace: Workspace | null, options: DoctorOptions): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  if (!workspace) {
    return [
      {
        ok: false,
        label: "workspace",
        detail: "No .kbx/ found. Run kbx init, or run kbx init --git-root from inside a repository."
      }
    ];
  }

  lines.push({ ok: true, label: "workspace", detail: workspace.root });
  const platformSupported = isSupportedPlatform();
  lines.push({
    ok: platformSupported,
    label: "platform",
    detail: `${process.platform} ${process.arch}${platformSupported ? "" : " is not supported by v1 Zvec bindings"}`
  });

  const manifest = await loadManifest(workspace);
  lines.push({
    ok: manifest.schema_version === 1 && manifest.workspace_id.length > 0,
    label: "manifest",
    detail: `${manifest.name} (${manifest.workspace_id.slice(0, 8)})`
  });

  await loadConfig(workspace);
  lines.push({ ok: true, label: "config", detail: "valid" });

  const sources = await loadSources(workspace);
  lines.push({ ok: sources.length > 0, label: "sources", detail: `${sources.length} source(s)` });

  const registry = await loadRegistry();
  const registered = registry.some((entry) => entry.workspace_id === manifest.workspace_id);
  lines.push({ ok: registered, label: "registry", detail: registered ? "registered" : "missing entry; run kbx init from this workspace to repair registration" });

  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  lines.push({
    ok: true,
    label: "stats",
    detail: `${Object.keys(stats.files).length} file(s), last ingest ${stats.last_ingest_at || "never"}`
  });

  let vectorChunkCount: number | null = null;
  try {
    const store = await ChunkVectorStore.open(workspace, manifest.dim, { readOnly: true });
    try {
      vectorChunkCount = store.docCount;
      lines.push({ ok: true, label: "collection", detail: `${vectorChunkCount} chunk(s), ${formatBytes(await directorySizeBytes(workspace.collectionDir))}` });
    } finally {
      store.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lines.push({ ok: false, label: "collection", detail: `${detail}; run kbx ingest to create it, or kbx reset --yes then kbx ingest if it is corrupt` });
  }

  try {
    const lexical = await LexicalIndexStore.open(workspace, { readOnly: true });
    try {
      const lexicalContentCount = lexical.contentCount;
      const statsChunkCount = totalIndexedChunks(stats);
      const matchesCollection = vectorChunkCount === null || lexicalContentCount === vectorChunkCount;
      const matchesStats = lexical.chunkCount === statsChunkCount;
      lines.push({
        ok: matchesCollection && matchesStats,
        label: "lexical",
        detail: lexicalHealthDetail({
          aliasCount: lexical.chunkCount,
          contentCount: lexicalContentCount,
          statsChunkCount,
          vectorChunkCount,
          matchesCollection,
          matchesStats
        })
      });
    } finally {
      await lexical.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lines.push({ ok: false, label: "lexical", detail: `${detail}; run kbx ingest to repair hybrid retrieval` });
  }

  const cachedBenchmark = await cachedModelBenchmark(manifest.model, manifest.dim);
  lines.push({
    ok: true,
    label: "model",
    detail: cachedBenchmark
      ? `${manifest.model} (${manifest.dim}d); cached benchmark ${cachedBenchmark.chunks_per_second.toFixed(1)} chunks/s from ${cachedBenchmark.measured_at}`
      : `${manifest.model} (${manifest.dim}d); run kbx model benchmark to verify local embedding performance`
  });
  lines.push({ ok: true, label: "mcp", detail: `stdio server available via: {"command":"kbx","args":["mcp"]}` });
  const adapterChecks = validateAllAdapterConfigs();
  const failedAdapters = adapterChecks.filter((check) => !check.ok);
  lines.push({
    ok: failedAdapters.length === 0,
    label: "mcp-adapters",
    detail: failedAdapters.length === 0
      ? `${adapterChecks.length} config template(s) valid`
      : failedAdapters.map((check) => `${check.adapter}: ${check.detail}`).join("; ")
  });
  const hookAdapters = generateAllAdapterHooks();
  lines.push({
    ok: hookAdapters.length > 0,
    label: "hook-adapters",
    detail: `${hookAdapters.length} hook adapter(s) available${hookAdapters.length > 0 ? `: ${hookAdapters.map((snippet) => snippet.adapter).join(", ")}` : ""}`
  });

  if (options.fresh) {
    lines.push(await freshnessLine(workspace, stats));
  }

  if (options.bench) {
    lines.push(await benchmarkLine(manifest.model, manifest.dim));
  }

  return lines;
}

function lexicalHealthDetail(input: {
  aliasCount: number;
  contentCount: number;
  statsChunkCount: number;
  vectorChunkCount: number | null;
  matchesCollection: boolean;
  matchesStats: boolean;
}): string {
  const base = `${input.aliasCount} chunk alias(es), ${input.contentCount} unique content chunk(s)`;
  const collection = input.vectorChunkCount === null
    ? "collection count unavailable"
    : input.matchesCollection
      ? "matches collection"
      : `collection has ${input.vectorChunkCount}`;
  const stats = input.matchesStats
    ? "matches stats"
    : `stats have ${input.statsChunkCount} chunk alias(es)`;
  const repair = input.matchesCollection && input.matchesStats ? "" : "; run kbx ingest to repair hybrid retrieval";
  return `${base}, ${collection}, ${stats}${repair}`;
}

function totalIndexedChunks(stats: IndexStats): number {
  return Object.values(stats.files).reduce((total, file) => total + file.chunks, 0);
}

export async function freshnessLine(workspace: Workspace, stats: IndexStats): Promise<DoctorLine> {
  void stats;
  const { stale, deleted, newFiles } = await scanWorkspaceFreshness(workspace);

  const ok = stale === 0 && deleted === 0 && newFiles === 0;
  return {
    ok,
    label: "freshness",
    detail: `${stale} stale, ${deleted} deleted, ${newFiles} new${ok ? "" : "; run kbx ingest to refresh the index"}`
  };
}

export async function benchmarkLine(model: string, dim: number): Promise<DoctorLine> {
  const embedder = createEmbedder(model, dim);
  const samples = [
    "kbx indexes local files for AI knowledge search.",
    "The MCP server is read-only in v1.",
    "Workspace knowledge bases live under .kbx.",
    "Search retrieves chunks and citations.",
    "CPU embeddings are the default execution mode."
  ];
  const started = performance.now();
  await embedder.embed(samples);
  const elapsedMs = Math.max(performance.now() - started, 1);
  const elapsedSeconds = elapsedMs / 1000;
  const chunksPerSecond = samples.length / elapsedSeconds;
  await saveModelBenchmarkResult({
    model,
    dim,
    platform: process.platform,
    arch: process.arch,
    measured_at: new Date().toISOString(),
    samples: samples.length,
    elapsed_ms: elapsedMs,
    chunks_per_second: chunksPerSecond
  });
  return {
    ok: true,
    label: "benchmark",
    detail: `${chunksPerSecond.toFixed(1)} chunks/s over ${samples.length} sample chunk(s); cached machine result`
  };
}

function isSupportedPlatform(): boolean {
  if (process.platform === "win32") {
    return process.arch === "x64";
  }
  if (process.platform === "linux") {
    return process.arch === "x64" || process.arch === "arm64";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64";
  }
  return false;
}
