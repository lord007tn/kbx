import { chunkMarkdown, chunkSentences, chunkText } from "./chunk";
import { branchContextForSource, indexedRelativePath, isIndexedInBranch, sourceKeyForPath, type BranchContext } from "./branch";
import { encodeChunkTags } from "./chunk-tags";
import { extractIndexableText, isDocumentExtension } from "./document-text";
import { createEmbedder } from "./embedding";
import { listIndexableFileEntries } from "./files";
import { readJson, writeJson } from "./io";
import { LexicalIndexStore } from "./lexical-index";
import { loadConfig, loadManifest, loadSources, saveManifest, saveSources, touchManifest, type Workspace } from "./workspace";
import { coversSource, normalizeSources, sourceForIngestTarget } from "./sources";
import { SCHEMA_VERSION, type ChunkRecord, type EmbeddedChunkRecord, type IndexStats, type SourceEntry, type WorkspaceManifest } from "./types";
import { ChunkVectorStore } from "./vector-store";
import { access, mkdir, rename, rm } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const EMBED_BATCH_SIZE = 64;
const LEXICAL_REPAIR_BATCH_SIZE = 512;

export interface IngestResult {
  files: number;
  chunks: number;
  skipped: number;
  deleted: number;
}

export interface RefreshResult extends IngestResult {
  sources: number;
}

export interface FreshnessScanResult {
  sources: number;
  stale: number;
  deleted: number;
  newFiles: number;
}

export interface FreshnessRefreshResult extends FreshnessScanResult {
  refreshed: boolean;
  skipped_reason?: string;
  refresh?: RefreshResult;
}

export type IngestProgressEvent =
  | { phase: "prepare"; target: string }
  | { phase: "scan-start"; source: string }
  | { phase: "scan-complete"; source: string; totalFiles: number }
  | { phase: "delete"; source: string; processedFiles: number; deletedFiles: number }
  | { phase: "file"; source: string; file: string; processedFiles: number; totalFiles: number; insertedChunks: number; skippedFiles: number; deletedFiles: number }
  | { phase: "complete"; source: string; totalFiles: number; insertedChunks: number; skippedFiles: number; deletedFiles: number };

export interface IngestProgressOptions {
  onProgress?: (event: IngestProgressEvent) => void | Promise<void>;
}

export interface IngestWorkspaceTargetOptions extends IngestProgressOptions {
  allowExternal?: boolean;
  include?: string[];
  exclude?: string[];
  noGitignore?: boolean;
}

export async function ingestWorkspaceTarget(
  workspace: Workspace,
  target: string,
  options: IngestWorkspaceTargetOptions = {}
): Promise<IngestResult> {
  const existingSources = await loadSources(workspace);
  await options.onProgress?.({ phase: "prepare", target });
  const source = await sourceForIngestTarget(workspace, target, options);
  const sources = normalizeSources([...existingSources, source]);
  await saveSources(workspace, sources);
  return ingestSource(workspace, source, options);
}

export async function ingestSource(workspace: Workspace, source: SourceEntry, options: IngestProgressOptions = {}): Promise<IngestResult> {
  const [manifest, config] = await Promise.all([
    loadManifest(workspace),
    loadConfig(workspace)
  ]);

  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  const branch = await branchContextForSource(workspace, source);
  await options.onProgress?.({ phase: "scan-start", source: source.path });
  const files = await listIndexableFileEntries(workspace.root, source.path, {
    includeKbxImports: source.kind === "external_import",
    includeKbxSessions: source.kind === "session_memory",
    include: source.include,
    exclude: source.exclude,
    useGitignore: source.no_gitignore === true ? false : true
  });
  await options.onProgress?.({ phase: "scan-complete", source: source.path, totalFiles: files.length });
  const currentFilePaths = new Set(files.map((file) => sourceKeyForPath(file.relativePath, branch)));
  const embedder = createEmbedder(manifest.model, manifest.dim);
  const store = await ChunkVectorStore.open(workspace, manifest.dim);
  const lexical = await LexicalIndexStore.open(workspace);
  const lexicalRepairNeeded = lexical.chunkCount !== totalIndexedChunks(stats);
  const lexicalRepairChunks: ChunkRecord[] = [];
  let skipped = 0;
  let deleted = 0;
  let insertedChunks = 0;

  const queueLexicalRepair = async (chunks: ChunkRecord[]) => {
    lexicalRepairChunks.push(...chunks);
    if (lexicalRepairChunks.length >= LEXICAL_REPAIR_BATCH_SIZE) {
      await flushLexicalRepair();
    }
  };

  const flushLexicalRepair = async () => {
    if (lexicalRepairChunks.length === 0) {
      return;
    }
    lexical.upsertChunks(lexicalRepairChunks.splice(0));
  };

  try {
    for (const [fileKey, indexed] of Object.entries(stats.files)) {
      const relativePath = indexedRelativePath(fileKey, indexed);
      if (
        sourceIncludesFile(source, relativePath)
        && isIndexedInBranch(indexed, branch?.scope)
        && !currentFilePaths.has(fileKey)
      ) {
        deleteSourceAlias(store, lexical, fileKey);
        delete stats.files[fileKey];
        deleted += 1;
        await options.onProgress?.({
          phase: "delete",
          source: source.path,
          processedFiles: files.length,
          deletedFiles: deleted
        });
      }
    }

    for (const [index, file] of files.entries()) {
      const fileKey = sourceKeyForPath(file.relativePath, branch);
      const existingFile = stats.files[fileKey];
      if (existingFile && existingFile.mtime === file.mtime) {
        if (
          lexicalRepairNeeded
          && sourceIncludesFile(source, file.relativePath)
          && lexical.sourceChunkCount(fileKey) !== existingFile.chunks
        ) {
          let content: string;
          try {
            content = await extractIndexableText(file.absolutePath, file.extension);
          } catch (error) {
            if (!isMissingFileError(error)) {
              throw error;
            }
            deleteSourceAlias(store, lexical, fileKey);
            delete stats.files[fileKey];
            deleted += 1;
            await options.onProgress?.({
              phase: "file",
              source: source.path,
              file: file.relativePath,
              processedFiles: index + 1,
              totalFiles: files.length,
              insertedChunks,
              skippedFiles: skipped,
              deletedFiles: deleted
            });
            continue;
          }
          await queueLexicalRepair(chunksForFile(source, file.relativePath, fileKey, file.extension, file.mtime, content, config, branch));
        }
        skipped += 1;
        await options.onProgress?.({
          phase: "file",
          source: source.path,
          file: file.relativePath,
          processedFiles: index + 1,
          totalFiles: files.length,
          insertedChunks,
          skippedFiles: skipped,
          deletedFiles: deleted
        });
        continue;
      }

      deleteSourceAlias(store, lexical, fileKey);
      let content: string;
      try {
        content = await extractIndexableText(file.absolutePath, file.extension);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
        delete stats.files[fileKey];
        deleteSourceAlias(store, lexical, fileKey);
        deleted += 1;
        await options.onProgress?.({
          phase: "file",
          source: source.path,
          file: file.relativePath,
          processedFiles: index + 1,
          totalFiles: files.length,
          insertedChunks,
          skippedFiles: skipped,
          deletedFiles: deleted
        });
        continue;
      }

      const contentHash = hashContent(content);
      const chunks = chunksForFile(source, file.relativePath, fileKey, file.extension, file.mtime, content, config, branch);

      insertedChunks += await embedAndUpsert(store, embedder, chunks);
      lexical.upsertChunks(chunks);

      stats.files[fileKey] = {
        mtime: file.mtime,
        chunks: chunks.length,
        relative_path: file.relativePath,
        branch_scope: branch?.scope,
        branch_name: branch?.name,
        git_head: branch?.head,
        content_hash: contentHash
      };
      await options.onProgress?.({
        phase: "file",
        source: source.path,
        file: file.relativePath,
        processedFiles: index + 1,
        totalFiles: files.length,
        insertedChunks,
        skippedFiles: skipped,
        deletedFiles: deleted
      });
    }

    const nextStats: IndexStats = {
      schema_version: SCHEMA_VERSION,
      model: manifest.model,
      dim: manifest.dim,
      last_ingest_at: new Date().toISOString(),
      files: stats.files
    };
    await flushLexicalRepair();
    await writeJson(workspace.statsPath, nextStats);
    await touchManifest(workspace);

    const result = {
      files: files.length,
      chunks: insertedChunks,
      skipped,
      deleted
    };
    await options.onProgress?.({
      phase: "complete",
      source: source.path,
      totalFiles: files.length,
      insertedChunks,
      skippedFiles: skipped,
      deletedFiles: deleted
    });
    return result;
  } finally {
    store.close();
    await lexical.close();
  }
}

function chunksForFile(
  source: SourceEntry,
  relativePath: string,
  sourceKey: string,
  extension: string,
  mtime: number,
  content: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  branch: BranchContext | null
): ChunkRecord[] {
  const isMarkdown = extension === ".md" || extension === ".mdx";
  const isDocument = isDocumentExtension(extension);
  const chunkInput = {
    source: sourceKey,
    content,
    maxChars: config.chunk.size,
    overlapChars: config.chunk.overlap,
    stripFrontmatter: isMarkdown
  };
  const textChunks = isMarkdown && config.chunk.strategy === "heading"
    ? chunkMarkdown(chunkInput)
    : config.chunk.strategy === "sentence" || isDocument
      ? chunkSentences(chunkInput)
      : chunkText(chunkInput);

  return textChunks.map((chunk) => {
    const chunkContentHash = hashContent(chunk.text);
    return {
      id: chunk.id,
      content_id: `c${chunkContentHash.slice(0, 23)}`,
      text: chunk.text,
      source: sourceKey,
      human_source: humanSource(source, relativePath),
      citation_source: citationSource(source, relativePath),
      source_origin: source.kind,
      chunk_idx: chunk.chunk_idx,
      mtime,
      tags: encodeChunkTags({
        branch_scope: branch?.scope,
        branch_name: branch?.name,
        git_head: branch?.head,
        content_hash: chunkContentHash
      })
    };
  });
}

function totalIndexedChunks(stats: IndexStats): number {
  return Object.values(stats.files).reduce((total, file) => total + file.chunks, 0);
}

export async function refreshWorkspaceIndex(workspace: Workspace): Promise<RefreshResult> {
  const sources = await loadSources(workspace);
  let files = 0;
  let chunks = 0;
  let skipped = 0;
  let deleted = 0;

  for (const source of sources) {
    const result = await ingestSource(workspace, source);
    files += result.files;
    chunks += result.chunks;
    skipped += result.skipped;
    deleted += result.deleted;
  }

  return {
    sources: sources.length,
    files,
    chunks,
    skipped,
    deleted
  };
}

export async function scanWorkspaceFreshness(workspace: Workspace): Promise<FreshnessScanResult> {
  const manifest = await loadManifest(workspace);
  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  const sources = await loadSources(workspace);
  const currentFiles = new Map<string, number>();
  const currentBranchScopes = new Set<string>();

  for (const source of sources) {
    const branch = await branchContextForSource(workspace, source);
    if (branch) {
      currentBranchScopes.add(branch.scope);
    }
    const files = await listIndexableFileEntries(workspace.root, source.path, {
      includeKbxImports: source.kind === "external_import",
      includeKbxSessions: source.kind === "session_memory",
      include: source.include,
      exclude: source.exclude,
      useGitignore: source.no_gitignore === true ? false : true
    });
    for (const file of files) {
      currentFiles.set(sourceKeyForPath(file.relativePath, branch), file.mtime);
    }
  }

  let stale = 0;
  let deleted = 0;
  for (const [fileKey, indexed] of Object.entries(stats.files)) {
    if (indexed.branch_scope && !currentBranchScopes.has(indexed.branch_scope)) {
      continue;
    }
    const currentMtime = currentFiles.get(fileKey);
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

  return {
    sources: sources.length,
    stale,
    deleted,
    newFiles
  };
}

export async function refreshWorkspaceFreshness(
  workspace: Workspace,
  options: { maxChanges?: number } = {}
): Promise<FreshnessRefreshResult> {
  const scan = await scanWorkspaceFreshness(workspace);
  const changes = scan.stale + scan.deleted + scan.newFiles;
  if (changes === 0) {
    return {
      ...scan,
      refreshed: false
    };
  }

  if (options.maxChanges !== undefined && changes > options.maxChanges) {
    return {
      ...scan,
      refreshed: false,
      skipped_reason: `change_count_exceeded:${changes}/${options.maxChanges}`
    };
  }

  const refresh = await refreshWorkspaceIndex(workspace);
  return {
    ...scan,
    refreshed: true,
    refresh
  };
}

export async function refreshWorkspaceFile(workspace: Workspace, targetPath: string): Promise<RefreshResult> {
  const absoluteTarget = path.resolve(workspace.root, targetPath);
  const relativePath = path.relative(workspace.root, absoluteTarget).replaceAll("\\", "/");
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Refresh target must be inside the initialized workspace.");
  }

  const sources = await loadSources(workspace);
  const coveringSources = sources
    .filter((source) => sourceIncludesFile(source, relativePath))
    .sort((a, b) => b.path.length - a.path.length);

  if (coveringSources.length > 0) {
    const result = await ingestSource(workspace, coveringSources[0]!);
    return {
      sources: 1,
      ...result
    };
  }

  const result = await ingestWorkspaceTarget(workspace, absoluteTarget);
  return {
    sources: 1,
    ...result
  };
}

async function embedAndUpsert(
  store: ChunkVectorStore,
  embedder: ReturnType<typeof createEmbedder>,
  chunks: ChunkRecord[]
): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
    const uniqueChunks = [...new Map(batch.map((chunk) => [chunk.content_id ?? chunk.id, chunk])).values()];
    const existing = store.existingIds(uniqueChunks.map((chunk) => chunk.content_id ?? chunk.id));
    const chunksToEmbed = uniqueChunks.filter((chunk) => !existing.has(chunk.content_id ?? chunk.id));
    if (chunksToEmbed.length === 0) {
      inserted += batch.length;
      continue;
    }
    const embeddings = await embedder.embed(chunksToEmbed.map((chunk) => chunk.text));
    const embeddedChunks: EmbeddedChunkRecord[] = chunksToEmbed.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? []
    }));
    store.upsertChunks(embeddedChunks);
    inserted += batch.length;
  }
  return inserted;
}

function deleteSourceAlias(store: ChunkVectorStore, lexical: LexicalIndexStore, source: string): void {
  const contentIds = lexical.contentIdsForSource(source);
  store.deleteSource(source);
  lexical.deleteSource(source);
  for (const contentId of contentIds) {
    if (!lexical.hasContent(contentId)) {
      store.deleteContent(contentId);
    }
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
    if (!isMissingFileError(error)) {
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
    rm(workspace.lexicalPath, { force: true }),
    rm(path.join(workspace.kbxDir, "lexical-index.json"), { force: true }),
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
    lexicalPath: path.join(tempDir, "lexical.db"),
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
  const lexical = await LexicalIndexStore.open(workspace);
  let removedFiles = 0;

  try {
    for (const [fileKey, indexed] of Object.entries(stats.files)) {
      if (sourceIncludesFile(source, indexedRelativePath(fileKey, indexed))) {
        deleteSourceAlias(store, lexical, fileKey);
        delete stats.files[fileKey];
        removedFiles += 1;
      }
    }
  } finally {
    store.close();
    await lexical.close();
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
  const backupLexicalPath = path.join(workspace.kbxDir, `lexical.backup-${suffix}.db`);
  const backupStatsPath = path.join(workspace.kbxDir, `stats.backup-${suffix}.json`);
  const oldManifest = await loadManifest(workspace);
  let backedUpCollection = false;
  let backedUpLexical = false;
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
    if (await exists(workspace.lexicalPath)) {
      await rename(workspace.lexicalPath, backupLexicalPath);
      backedUpLexical = true;
    }

    await rename(tempWorkspace.collectionDir, workspace.collectionDir);
    if (await exists(tempWorkspace.lexicalPath)) {
      await rename(tempWorkspace.lexicalPath, workspace.lexicalPath);
    } else {
      await rm(workspace.lexicalPath, { force: true });
    }
    await rename(tempWorkspace.statsPath, workspace.statsPath);
    await saveManifest(workspace, nextManifest);

    await Promise.all([
      rm(backupCollectionDir, { recursive: true, force: true }),
      rm(backupLexicalPath, { force: true }),
      rm(backupStatsPath, { force: true })
    ]);
  } catch (error) {
    await Promise.all([
      rm(workspace.collectionDir, { recursive: true, force: true }),
      rm(workspace.lexicalPath, { force: true }),
      rm(workspace.statsPath, { force: true })
    ]);
    if (backedUpCollection) {
      await rename(backupCollectionDir, workspace.collectionDir).catch(() => undefined);
    }
    if (backedUpStats) {
      await rename(backupStatsPath, workspace.statsPath).catch(() => undefined);
    }
    if (backedUpLexical) {
      await rename(backupLexicalPath, workspace.lexicalPath).catch(() => undefined);
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

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
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
  if (source.kind === "workspace" && isManagedKbxContent(filePath)) {
    return false;
  }
  return coversSource(source.path, filePath) || source.path === filePath;
}

function humanSource(source: { kind: string; path: string; original_path?: string }, filePath: string): string {
  if (source.kind === "session_memory") {
    return `session-memory:${path.basename(filePath, path.extname(filePath))}`;
  }
  if (source.kind !== "external_import" || !source.original_path) {
    return filePath;
  }
  const relative = relativeToSource(source.path, filePath);
  return `${source.original_path}${relative ? `/${relative}` : ""}`;
}

function citationSource(source: { kind: string; path: string }, filePath: string): string {
  if (source.kind === "session_memory") {
    return `session-memory:${path.basename(filePath, path.extname(filePath))}`;
  }
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

function isKbxSession(filePath: string): boolean {
  return filePath === ".kbx/sessions" || filePath.startsWith(".kbx/sessions/");
}

function isManagedKbxContent(filePath: string): boolean {
  return isKbxImport(filePath) || isKbxSession(filePath);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
