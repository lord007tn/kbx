import { performance } from "node:perf_hooks";
import { createEmbedder } from "./embedding";
import { listIndexableFileEntries } from "./files";
import { directorySizeBytes, formatBytes } from "./io";
import { loadIndexStats } from "./indexer";
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
        detail: "No .kbx/ found. Run kbx init."
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
  lines.push({ ok: registered, label: "registry", detail: registered ? "registered" : "missing entry" });

  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  lines.push({
    ok: true,
    label: "stats",
    detail: `${Object.keys(stats.files).length} file(s), last ingest ${stats.last_ingest_at || "never"}`
  });

  try {
    const store = await ChunkVectorStore.open(workspace, manifest.dim, { readOnly: true });
    try {
      lines.push({ ok: true, label: "collection", detail: `${store.docCount} chunk(s), ${formatBytes(await directorySizeBytes(workspace.collectionDir))}` });
    } finally {
      store.close();
    }
  } catch (error) {
    lines.push({ ok: false, label: "collection", detail: error instanceof Error ? error.message : String(error) });
  }

  lines.push({ ok: true, label: "model", detail: `${manifest.model} (${manifest.dim}d)` });

  if (options.fresh) {
    lines.push(await freshnessLine(workspace, stats));
  }

  if (options.bench) {
    lines.push(await benchmarkLine(manifest.model, manifest.dim));
  }

  return lines;
}

export async function freshnessLine(workspace: Workspace, stats: IndexStats): Promise<DoctorLine> {
  const sources = await loadSources(workspace);
  const currentFiles = new Map<string, number>();
  for (const source of sources) {
    for (const file of await listIndexableFileEntries(workspace.root, source.path, {
      includeKbxImports: source.kind === "external_import",
      include: source.include,
      exclude: source.exclude,
      useGitignore: source.no_gitignore === true ? false : true
    })) {
      currentFiles.set(file.relativePath, file.mtime);
    }
  }

  let stale = 0;
  let deleted = 0;
  for (const [filePath, indexed] of Object.entries(stats.files)) {
    const currentMtime = currentFiles.get(filePath);
    if (currentMtime === undefined) {
      deleted += 1;
    } else if (currentMtime !== indexed.mtime) {
      stale += 1;
    }
  }

  let newFiles = 0;
  for (const filePath of currentFiles.keys()) {
    if (!stats.files[filePath]) {
      newFiles += 1;
    }
  }

  const ok = stale === 0 && deleted === 0 && newFiles === 0;
  return {
    ok,
    label: "freshness",
    detail: `${stale} stale, ${deleted} deleted, ${newFiles} new`
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
  const elapsedSeconds = Math.max((performance.now() - started) / 1000, 0.001);
  return {
    ok: true,
    label: "benchmark",
    detail: `${(samples.length / elapsedSeconds).toFixed(1)} chunks/s over ${samples.length} sample chunk(s)`
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
