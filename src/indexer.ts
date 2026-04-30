import { chunkMarkdown, chunkText } from "./chunk.js";
import { createEmbedder } from "./embedding.js";
import { listIndexableFiles } from "./files.js";
import { readJson, writeJson } from "./io.js";
import { loadConfig, loadManifest, loadSources, saveSources, touchManifest, type Workspace } from "./workspace.js";
import { coversSource, normalizeSources, sourceForTarget } from "./sources.js";
import { SCHEMA_VERSION, type ChunkRecord, type EmbeddedChunkRecord, type IndexStats } from "./types.js";
import { ChunkVectorStore } from "./vector-store.js";
import { rm } from "node:fs/promises";

export interface IngestResult {
  files: number;
  chunks: number;
  skipped: number;
  deleted: number;
}

export async function ingestWorkspaceTarget(workspace: Workspace, target: string): Promise<IngestResult> {
  const [manifest, config, existingSources] = await Promise.all([
    loadManifest(workspace),
    loadConfig(workspace),
    loadSources(workspace)
  ]);
  const source = sourceForTarget(workspace.root, target);
  const sources = normalizeSources([...existingSources, source]);
  await saveSources(workspace, sources);

  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  const files = await listIndexableFiles(workspace.root, source.path);
  const currentFilePaths = new Set(files.map((file) => file.relativePath));
  const embedder = createEmbedder(manifest.model, manifest.dim);
  const store = await ChunkVectorStore.open(workspace, manifest.dim);
  const chunksToEmbed: ChunkRecord[] = [];
  let skipped = 0;
  let deleted = 0;

  try {
    for (const filePath of Object.keys(stats.files)) {
      if (isCoveredBySource(source.path, filePath) && !currentFilePaths.has(filePath)) {
        store.deleteSource(filePath);
        delete stats.files[filePath];
        deleted += 1;
      }
    }

    for (const file of files) {
      const existingFile = stats.files[file.relativePath];
      if (existingFile && existingFile.mtime === file.mtime) {
        skipped += 1;
        continue;
      }

      store.deleteSource(file.relativePath);

      const isMarkdown = file.extension === ".md" || file.extension === ".mdx";
      const textChunks = isMarkdown && config.chunk.strategy === "heading"
        ? chunkMarkdown({
            source: file.relativePath,
            content: file.content,
            maxChars: config.chunk.size,
            overlapChars: config.chunk.overlap
          })
        : chunkText({
            source: file.relativePath,
            content: file.content,
            maxChars: config.chunk.size,
            overlapChars: config.chunk.overlap,
            stripFrontmatter: isMarkdown
          });

      for (const chunk of textChunks) {
        chunksToEmbed.push({
          id: chunk.id,
          text: chunk.text,
          source: file.relativePath,
          human_source: file.relativePath,
          citation_source: file.relativePath,
          source_origin: "workspace",
          chunk_idx: chunk.chunk_idx,
          mtime: file.mtime,
          tags: ""
        });
      }

      stats.files[file.relativePath] = {
        mtime: file.mtime,
        chunks: textChunks.length
      };
    }

    const embeddings = chunksToEmbed.length > 0 ? await embedder.embed(chunksToEmbed.map((chunk) => chunk.text)) : [];
    const embeddedChunks: EmbeddedChunkRecord[] = chunksToEmbed.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? []
    }));
    store.upsertChunks(embeddedChunks);

    const nextStats: IndexStats = {
      schema_version: SCHEMA_VERSION,
      model: manifest.model,
      dim: manifest.dim,
      last_ingest_at: new Date().toISOString(),
      files: stats.files
    };
    await writeJson(workspace.statsPath, nextStats);
    await touchManifest(workspace);

    return {
      files: files.length,
      chunks: embeddedChunks.length,
      skipped,
      deleted
    };
  } finally {
    store.close();
  }
}

export async function loadIndexStats(workspace: Workspace, model: string, dim: number): Promise<IndexStats> {
  try {
    const stats = await readJson<IndexStats>(workspace.statsPath);
    if (stats.model !== model || stats.dim !== dim) {
      throw new Error("Index stats model does not match workspace manifest. Re-run kbx ingest after resetting the collection.");
    }
    return stats;
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not match")) {
      throw error;
    }
    return {
      schema_version: SCHEMA_VERSION,
      model,
      dim,
      last_ingest_at: "",
      files: {}
    };
  }
}

export async function resetWorkspaceIndex(workspace: Workspace): Promise<void> {
  await Promise.all([
    rm(workspace.collectionDir, { recursive: true, force: true }),
    rm(workspace.statsPath, { force: true })
  ]);
  await touchManifest(workspace);
}

export interface RemoveSourceResult {
  source: string;
  removedFiles: number;
}

export async function removeSource(workspace: Workspace, selector: string): Promise<RemoveSourceResult> {
  const [manifest, sources] = await Promise.all([loadManifest(workspace), loadSources(workspace)]);
  const sourceIndex = resolveSourceIndex(sources, selector);
  const source = sources[sourceIndex];
  if (!source) {
    throw new Error(`No source matches "${selector}".`);
  }

  for (const other of sources) {
    if (other.path !== source.path && coversSource(other.path, source.path)) {
      throw new Error(`Cannot remove ${source.path}; it is covered by broader source ${other.path}.`);
    }
  }

  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  const store = await ChunkVectorStore.open(workspace, manifest.dim);
  let removedFiles = 0;

  try {
    for (const filePath of Object.keys(stats.files)) {
      if (isCoveredBySource(source.path, filePath)) {
        store.deleteSource(filePath);
        delete stats.files[filePath];
        removedFiles += 1;
      }
    }
  } finally {
    store.close();
  }

  const nextSources = sources.filter((_, index) => index !== sourceIndex);
  await saveSources(workspace, nextSources);
  await writeJson(workspace.statsPath, {
    ...stats,
    last_ingest_at: new Date().toISOString()
  });
  await touchManifest(workspace);

  return {
    source: source.path,
    removedFiles
  };
}

function resolveSourceIndex(sources: Array<{ path: string }>, selector: string): number {
  const asNumber = Number.parseInt(selector, 10);
  if (Number.isInteger(asNumber) && String(asNumber) === selector && asNumber >= 1 && asNumber <= sources.length) {
    return asNumber - 1;
  }

  const matches = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.path === selector);
  if (matches.length === 1) {
    return matches[0]!.index;
  }
  if (matches.length > 1) {
    throw new Error(`Source selector "${selector}" is ambiguous.`);
  }

  throw new Error(`No source matches "${selector}".`);
}

function isCoveredBySource(sourcePath: string, filePath: string): boolean {
  return coversSource(sourcePath, filePath) || sourcePath === filePath;
}
