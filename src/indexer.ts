import { chunkMarkdown, chunkText } from "./chunk";
import { createEmbedder } from "./embedding";
import { listIndexableFileEntries } from "./files";
import { readJson, writeJson } from "./io";
import { loadConfig, loadManifest, loadSources, saveManifest, saveSources, touchManifest, type Workspace } from "./workspace";
import { coversSource, normalizeSources, sourceForIngestTarget } from "./sources";
import { SCHEMA_VERSION, type ChunkRecord, type EmbeddedChunkRecord, type IndexStats, type SourceEntry, type WorkspaceManifest } from "./types";
import { ChunkVectorStore } from "./vector-store";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const EMBED_BATCH_SIZE = 64;

export interface IngestResult {
  files: number;
  chunks: number;
  skipped: number;
  deleted: number;
}

export async function ingestWorkspaceTarget(
  workspace: Workspace,
  target: string,
  options: { allowExternal?: boolean; include?: string[]; exclude?: string[]; noGitignore?: boolean } = {}
): Promise<IngestResult> {
  const existingSources = await loadSources(workspace);
  const source = await sourceForIngestTarget(workspace, target, options);
  const sources = normalizeSources([...existingSources, source]);
  await saveSources(workspace, sources);
  return ingestSource(workspace, source);
}

export async function ingestSource(workspace: Workspace, source: SourceEntry): Promise<IngestResult> {
  const [manifest, config] = await Promise.all([
    loadManifest(workspace),
    loadConfig(workspace)
  ]);

  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  const files = await listIndexableFileEntries(workspace.root, source.path, {
    includeKbxImports: source.kind === "external_import",
    include: source.include,
    exclude: source.exclude,
    useGitignore: source.no_gitignore === true ? false : true
  });
  const currentFilePaths = new Set(files.map((file) => file.relativePath));
  const embedder = createEmbedder(manifest.model, manifest.dim);
  const store = await ChunkVectorStore.open(workspace, manifest.dim);
  let skipped = 0;
  let deleted = 0;
  let insertedChunks = 0;

  try {
    for (const filePath of Object.keys(stats.files)) {
      if (sourceIncludesFile(source, filePath) && !currentFilePaths.has(filePath)) {
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
      const content = await readFile(file.absolutePath, "utf8");

      const isMarkdown = file.extension === ".md" || file.extension === ".mdx";
      const textChunks = isMarkdown && config.chunk.strategy === "heading"
        ? chunkMarkdown({
            source: file.relativePath,
            content,
            maxChars: config.chunk.size,
            overlapChars: config.chunk.overlap
          })
        : chunkText({
            source: file.relativePath,
            content,
            maxChars: config.chunk.size,
            overlapChars: config.chunk.overlap,
            stripFrontmatter: isMarkdown
          });

      const chunks: ChunkRecord[] = textChunks.map((chunk) => ({
        id: chunk.id,
        text: chunk.text,
        source: file.relativePath,
        human_source: humanSource(source, file.relativePath),
        citation_source: citationSource(source, file.relativePath),
        source_origin: source.kind,
        chunk_idx: chunk.chunk_idx,
        mtime: file.mtime,
        tags: ""
      }));

      insertedChunks += await embedAndUpsert(store, embedder, chunks);

      stats.files[file.relativePath] = {
        mtime: file.mtime,
        chunks: textChunks.length
      };
    }

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
      chunks: insertedChunks,
      skipped,
      deleted
    };
  } finally {
    store.close();
  }
}

async function embedAndUpsert(
  store: ChunkVectorStore,
  embedder: ReturnType<typeof createEmbedder>,
  chunks: ChunkRecord[]
): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
    const embeddings = await embedder.embed(batch.map((chunk) => chunk.text));
    const embeddedChunks: EmbeddedChunkRecord[] = batch.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? []
    }));
    store.upsertChunks(embeddedChunks);
    inserted += embeddedChunks.length;
  }
  return inserted;
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

export async function rebuildWorkspaceIndexForModel(
  workspace: Workspace,
  nextManifest: WorkspaceManifest,
  sources: SourceEntry[]
): Promise<void> {
  const suffix = `${process.pid}-${Date.now()}`;
  const tempDir = path.join(workspace.kbxDir, `.reindex-${suffix}`);
  const tempWorkspace: Workspace = {
    ...workspace,
    kbxDir: tempDir,
    manifestPath: path.join(tempDir, "manifest.json"),
    configPath: path.join(tempDir, "config.json"),
    sourcesPath: path.join(tempDir, "sources.json"),
    statsPath: path.join(tempDir, "stats.json"),
    collectionDir: path.join(tempDir, "collection")
  };

  await mkdir(tempDir, { recursive: true });
  await writeJson(tempWorkspace.manifestPath, nextManifest);
  await writeJson(tempWorkspace.configPath, await loadConfig(workspace));
  await writeJson(tempWorkspace.sourcesPath, sources);

  try {
    if (sources.length === 0) {
      const store = await ChunkVectorStore.open(tempWorkspace, nextManifest.dim);
      store.close();
      await writeJson(tempWorkspace.statsPath, emptyStats(nextManifest));
    } else {
      for (const source of sources) {
        await ingestSource(tempWorkspace, source);
      }
    }

    await swapRebuiltIndex(workspace, tempWorkspace, nextManifest);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export interface RemoveSourceResult {
  source: string;
  removedFiles: number;
  deletedImportSnapshot: boolean;
}

export async function removeSource(
  workspace: Workspace,
  selector: string,
  options: { deleteImportSnapshot?: boolean } = {}
): Promise<RemoveSourceResult> {
  const [manifest, sources] = await Promise.all([loadManifest(workspace), loadSources(workspace)]);
  const { source, index: sourceIndex } = resolveSourceEntry(sources, selector);

  for (const other of sources) {
    if (other.kind === "workspace" && source.kind === "workspace" && other.path !== source.path && coversSource(other.path, source.path)) {
      throw new Error(`Cannot remove ${source.path}; it is covered by broader source ${other.path}.`);
    }
  }

  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  const store = await ChunkVectorStore.open(workspace, manifest.dim);
  let removedFiles = 0;

  try {
    for (const filePath of Object.keys(stats.files)) {
      if (sourceIncludesFile(source, filePath)) {
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
  let deletedImportSnapshot = false;
  if (source.kind === "external_import" && options.deleteImportSnapshot === true) {
    await rm(importSnapshotRoot(workspace, source), { recursive: true, force: true });
    deletedImportSnapshot = true;
  }
  await touchManifest(workspace);

  return {
    source: source.path,
    removedFiles,
    deletedImportSnapshot
  };
}

export function resolveSourceEntry<T extends { path: string }>(sources: T[], selector: string): { source: T; index: number } {
  const asNumber = Number.parseInt(selector, 10);
  if (Number.isInteger(asNumber) && String(asNumber) === selector && asNumber >= 1 && asNumber <= sources.length) {
    return { source: sources[asNumber - 1]!, index: asNumber - 1 };
  }

  const matches = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.path === selector);
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Source selector "${selector}" is ambiguous.`);
  }

  throw new Error(`No source matches "${selector}".`);
}

async function swapRebuiltIndex(workspace: Workspace, tempWorkspace: Workspace, nextManifest: WorkspaceManifest): Promise<void> {
  const suffix = `${process.pid}-${Date.now()}`;
  const backupCollectionDir = path.join(workspace.kbxDir, `collection.backup-${suffix}`);
  const backupStatsPath = path.join(workspace.kbxDir, `stats.backup-${suffix}.json`);
  const oldManifest = await loadManifest(workspace);
  let backedUpCollection = false;
  let backedUpStats = false;

  try {
    if (await exists(workspace.collectionDir)) {
      await rename(workspace.collectionDir, backupCollectionDir);
      backedUpCollection = true;
    }
    if (await exists(workspace.statsPath)) {
      await rename(workspace.statsPath, backupStatsPath);
      backedUpStats = true;
    }

    await rename(tempWorkspace.collectionDir, workspace.collectionDir);
    await rename(tempWorkspace.statsPath, workspace.statsPath);
    await saveManifest(workspace, nextManifest);

    await Promise.all([
      rm(backupCollectionDir, { recursive: true, force: true }),
      rm(backupStatsPath, { force: true })
    ]);
  } catch (error) {
    await Promise.all([
      rm(workspace.collectionDir, { recursive: true, force: true }),
      rm(workspace.statsPath, { force: true })
    ]);
    if (backedUpCollection) {
      await rename(backupCollectionDir, workspace.collectionDir).catch(() => undefined);
    }
    if (backedUpStats) {
      await rename(backupStatsPath, workspace.statsPath).catch(() => undefined);
    }
    await saveManifest(workspace, oldManifest).catch(() => undefined);
    throw error;
  }
}

function emptyStats(manifest: WorkspaceManifest): IndexStats {
  return {
    schema_version: SCHEMA_VERSION,
    model: manifest.model,
    dim: manifest.dim,
    last_ingest_at: new Date().toISOString(),
    files: {}
  };
}

function importSnapshotRoot(workspace: Workspace, source: SourceEntry): string {
  return path.dirname(path.resolve(workspace.root, source.path));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sourceIncludesFile(source: SourceEntry, filePath: string): boolean {
  if (source.kind === "workspace" && isKbxImport(filePath)) {
    return false;
  }
  return coversSource(source.path, filePath) || source.path === filePath;
}

function humanSource(source: { kind: string; path: string; original_path?: string }, filePath: string): string {
  if (source.kind !== "external_import" || !source.original_path) {
    return filePath;
  }
  const relative = relativeToSource(source.path, filePath);
  return `${source.original_path}${relative ? `/${relative}` : ""}`;
}

function citationSource(source: { kind: string; path: string }, filePath: string): string {
  if (source.kind !== "external_import") {
    return filePath;
  }
  const relative = relativeToSource(source.path, filePath);
  return `external:${relative || "."}`;
}

function relativeToSource(sourcePath: string, filePath: string): string {
  return filePath === sourcePath ? "" : filePath.slice(sourcePath.length + 1);
}

function isKbxImport(filePath: string): boolean {
  return filePath === ".kbx/imports" || filePath.startsWith(".kbx/imports/");
}
