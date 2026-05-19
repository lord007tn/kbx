import { chunkMarkdown, chunkSentences, chunkText } from "./chunk";
import { branchContextForSource, indexedRelativePath, isIndexedInBranch, sourceKeyForPath, type BranchContext } from "./branch";
import { encodeChunkTags } from "./chunk-tags";
import { extractIndexableText, isDocumentExtension, isNonTextContentError } from "./document-text";
import { createEmbedder } from "./embedding";
import { listIndexableFileEntries, type SourceFileEntry } from "./files";
import { readJson, writeJson } from "./io";
import { LexicalIndexStore } from "./lexical-index";
import { loadConfig, loadManifest, loadSources, saveManifest, saveSources, touchManifest, type Workspace } from "./workspace";
import { coversSource, normalizeSources, sourceForIngestTarget } from "./sources";
import { SCHEMA_VERSION, type ChunkRecord, type EmbeddedChunkRecord, type IndexedFileStats, type IndexStats, type SourceEntry, type WorkspaceManifest } from "./types";
import { ChunkVectorStore } from "./vector-store";
import { access, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const EMBED_BATCH_SIZE = 64;
const LEXICAL_REPAIR_BATCH_SIZE = 512;
const WINDOWS_FS_RETRY_DELAYS_MS = [50, 100, 250, 500, 1000];

async function renamePath(from: string, to: string): Promise<void> {
  await retryWindowsFsOperation(() => rename(from, to));
}

async function removePath(target: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
  await retryWindowsFsOperation(() => rm(target, options));
}

async function moveCollectionPath(from: string, to: string, options: { allowSourceRemain?: boolean } = {}): Promise<void> {
  try {
    await renamePath(from, to);
    return;
  } catch (error) {
    if (process.platform !== "win32" || !isRetryableWindowsFsError(error) || !await isDirectory(from)) {
      throw error;
    }
  }

  await removePath(to, { recursive: true, force: true });
  await retryWindowsFsOperation(() => cp(from, to, { recursive: true, force: true }));
  if (options.allowSourceRemain === true) {
    await removePath(from, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  await removePath(from, { recursive: true, force: true });
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function retryWindowsFsOperation<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        process.platform !== "win32"
        || !isRetryableWindowsFsError(error)
        || attempt >= WINDOWS_FS_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await delay(WINDOWS_FS_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

function isRetryableWindowsFsError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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
  return ingestSourceAtomically(workspace, source, options, sources);
}

export async function ingestSource(workspace: Workspace, source: SourceEntry, options: IngestProgressOptions = {}): Promise<IngestResult> {
  return ingestSourceAtomically(workspace, source, options);
}

async function ingestSourceAtomically(
  workspace: Workspace,
  source: SourceEntry,
  options: IngestProgressOptions,
  nextSources?: SourceEntry[]
): Promise<IngestResult> {
  const tempWorkspace = await prepareTemporaryIndexWorkspace(workspace);
  let primaryError: unknown;
  let result: IngestResult | undefined;
  try {
    if (nextSources) {
      await writeJson(tempWorkspace.sourcesPath, nextSources);
    }
    result = await ingestSourceDirect(tempWorkspace, source, options);
    await swapIngestedIndex(workspace, tempWorkspace, { includeSources: nextSources !== undefined });
    await touchManifest(workspace);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await removePath(tempWorkspace.kbxDir, { recursive: true, force: true });
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  return result!;
}

async function ingestSourceDirect(workspace: Workspace, source: SourceEntry, options: IngestProgressOptions = {}): Promise<IngestResult> {
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
        && isCurrentIngestScope(indexed, branch?.scope)
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
      if (existingFile && indexedFileUnchanged(existingFile, file)) {
        if (
          lexicalRepairNeeded
          && sourceIncludesFile(source, file.relativePath)
          && lexical.sourceChunkCount(fileKey) !== existingFile.chunks
        ) {
          let content: string;
          try {
            content = await extractIndexableText(file.absolutePath, file.extension);
          } catch (error) {
            if (!isMissingFileError(error) && !isNonTextContentError(error)) {
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

      const hadExistingFile = existingFile !== undefined;
      deleteSourceAlias(store, lexical, fileKey);
      let content: string;
      try {
        content = await extractIndexableText(file.absolutePath, file.extension);
      } catch (error) {
        if (!isMissingFileError(error) && !isNonTextContentError(error)) {
          throw error;
        }
        delete stats.files[fileKey];
        deleteSourceAlias(store, lexical, fileKey);
        if (isNonTextContentError(error) && !hadExistingFile) {
          skipped += 1;
        } else {
          deleted += 1;
        }
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
      if (chunks.length === 0) {
        delete stats.files[fileKey];
        if (hadExistingFile) {
          deleted += 1;
        } else {
          skipped += 1;
        }
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

      insertedChunks += await embedAndUpsert(store, embedder, chunks);
      lexical.upsertChunks(chunks);

      stats.files[fileKey] = {
        mtime: file.mtime,
        size: file.size,
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

    const ingestedAt = new Date().toISOString();
    const nextBranches = {
      ...(stats.branches ?? {})
    };
    if (branch) {
      nextBranches[branch.scope] = {
        name: branch.name,
        git_head: branch.head,
        last_ingest_at: ingestedAt
      };
    }
    const nextStats: IndexStats = {
      schema_version: SCHEMA_VERSION,
      model: manifest.model,
      dim: manifest.dim,
      last_ingest_at: ingestedAt,
      branches: nextBranches,
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

async function prepareTemporaryIndexWorkspace(workspace: Workspace): Promise<Workspace> {
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const tempDir = path.join(workspace.kbxDir, `.ingest-${suffix}`);
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
  await Promise.all([
    copyIfExists(workspace.manifestPath, tempWorkspace.manifestPath),
    copyIfExists(workspace.configPath, tempWorkspace.configPath),
    copyIfExists(workspace.sourcesPath, tempWorkspace.sourcesPath),
    copyIfExists(workspace.statsPath, tempWorkspace.statsPath),
    copyIfExists(workspace.lexicalPath, tempWorkspace.lexicalPath),
    copyIfExists(workspace.collectionDir, tempWorkspace.collectionDir)
  ]);
  return tempWorkspace;
}

async function swapIngestedIndex(
  workspace: Workspace,
  tempWorkspace: Workspace,
  options: { includeSources?: boolean } = {}
): Promise<void> {
  const suffix = `${process.pid}-${Date.now()}`;
  const backupCollectionDir = path.join(workspace.kbxDir, `collection.backup-${suffix}`);
  const backupLexicalPath = path.join(workspace.kbxDir, `lexical.backup-${suffix}.db`);
  const backupStatsPath = path.join(workspace.kbxDir, `stats.backup-${suffix}.json`);
  const backupSourcesPath = path.join(workspace.kbxDir, `sources.backup-${suffix}.json`);
  let backedUpCollection = false;
  let backedUpLexical = false;
  let backedUpStats = false;
  let backedUpSources = false;

  try {
    if (await exists(workspace.collectionDir)) {
      await moveCollectionPath(workspace.collectionDir, backupCollectionDir);
      backedUpCollection = true;
    }
    if (await exists(workspace.lexicalPath)) {
      await renamePath(workspace.lexicalPath, backupLexicalPath);
      backedUpLexical = true;
    }
    if (await exists(workspace.statsPath)) {
      await renamePath(workspace.statsPath, backupStatsPath);
      backedUpStats = true;
    }
    if (options.includeSources === true && await exists(workspace.sourcesPath)) {
      await renamePath(workspace.sourcesPath, backupSourcesPath);
      backedUpSources = true;
    }

    await moveCollectionPath(tempWorkspace.collectionDir, workspace.collectionDir, { allowSourceRemain: true });
    if (await exists(tempWorkspace.lexicalPath)) {
      await renamePath(tempWorkspace.lexicalPath, workspace.lexicalPath);
    } else {
      await removePath(workspace.lexicalPath, { force: true });
    }
    await renamePath(tempWorkspace.statsPath, workspace.statsPath);
    if (options.includeSources === true) {
      await renamePath(tempWorkspace.sourcesPath, workspace.sourcesPath);
    }

    await Promise.all([
      removePath(backupCollectionDir, { recursive: true, force: true }),
      removePath(backupLexicalPath, { force: true }),
      removePath(backupStatsPath, { force: true }),
      removePath(backupSourcesPath, { force: true })
    ]);
  } catch (error) {
    await Promise.all([
      removePath(workspace.collectionDir, { recursive: true, force: true }),
      removePath(workspace.lexicalPath, { force: true }),
      removePath(workspace.statsPath, { force: true }),
      options.includeSources === true ? removePath(workspace.sourcesPath, { force: true }) : Promise.resolve()
    ]);
    if (backedUpCollection) {
      await moveCollectionPath(backupCollectionDir, workspace.collectionDir).catch(() => undefined);
    }
    if (backedUpLexical) {
      await renamePath(backupLexicalPath, workspace.lexicalPath).catch(() => undefined);
    }
    if (backedUpStats) {
      await renamePath(backupStatsPath, workspace.statsPath).catch(() => undefined);
    }
    if (backedUpSources) {
      await renamePath(backupSourcesPath, workspace.sourcesPath).catch(() => undefined);
    }
    throw error;
  }
}

async function copyIfExists(source: string, destination: string): Promise<void> {
  if (!await exists(source)) {
    return;
  }
  await cp(source, destination, { recursive: true, force: true });
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

function indexedFileUnchanged(indexed: IndexedFileStats, file: Pick<SourceFileEntry, "mtime" | "size">): boolean {
  return indexed.mtime === file.mtime && indexed.size === file.size;
}

function isCurrentIngestScope(indexed: IndexedFileStats, branchScope: string | undefined): boolean {
  if (isIndexedInBranch(indexed, branchScope)) {
    return true;
  }
  return branchScope !== undefined && indexed.branch_scope === undefined;
}

export async function refreshWorkspaceIndex(workspace: Workspace, options: IngestProgressOptions = {}): Promise<RefreshResult> {
  const sources = await loadSources(workspace);
  let files = 0;
  let chunks = 0;
  let skipped = 0;
  let deleted = 0;

  for (const source of sources) {
    const result = await ingestSource(workspace, source, options);
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
  const currentFiles = new Map<string, Pick<SourceFileEntry, "mtime" | "size">>();
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
      currentFiles.set(sourceKeyForPath(file.relativePath, branch), {
        mtime: file.mtime,
        size: file.size
      });
    }
  }

  let stale = 0;
  let deleted = 0;
  for (const [fileKey, indexed] of Object.entries(stats.files)) {
    if (indexed.branch_scope && !currentBranchScopes.has(indexed.branch_scope)) {
      continue;
    }
    const currentFile = currentFiles.get(fileKey);
    if (currentFile === undefined) {
      deleted += 1;
    } else if (!indexedFileUnchanged(indexed, currentFile)) {
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
  options: { maxChanges?: number } & IngestProgressOptions = {}
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

  const refresh = await refreshWorkspaceIndex(workspace, options);
  return {
    ...scan,
    refreshed: true,
    refresh
  };
}

export async function refreshWorkspaceFile(workspace: Workspace, targetPath: string, options: IngestProgressOptions = {}): Promise<RefreshResult> {
  const absoluteTarget = path.resolve(workspace.root, targetPath);
  const relativePath = path.relative(workspace.root, absoluteTarget).replaceAll("\\", "/");
  if (!isWorkspaceRelativePath(relativePath)) {
    throw new Error("Refresh target must be inside the initialized workspace.");
  }

  const sources = await loadSources(workspace);
  const coveringSources = sources
    .filter((source) => sourceIncludesFile(source, relativePath))
    .sort((a, b) => b.path.length - a.path.length);

  if (coveringSources.length > 0) {
    const result = await ingestSource(workspace, coveringSources[0]!, options);
    return {
      sources: 1,
      ...result
    };
  }

  const result = await ingestWorkspaceTarget(workspace, absoluteTarget, options);
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
    if (isSharedContentId(contentId) && !lexical.hasContent(contentId)) {
      store.deleteContent(contentId);
    }
  }
}

function isSharedContentId(id: string): boolean {
  return /^c[0-9a-f]{23}$/.test(id);
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
      branches: {},
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
  sources: SourceEntry[],
  options: IngestProgressOptions = {}
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

  let primaryError: unknown;
  try {
    if (sources.length === 0) {
      const store = await ChunkVectorStore.open(tempWorkspace, nextManifest.dim);
      store.close();
      await writeJson(tempWorkspace.statsPath, emptyStats(nextManifest));
    } else {
      for (const source of sources) {
        await ingestSourceDirect(tempWorkspace, source, options);
      }
    }

    await swapRebuiltIndex(workspace, tempWorkspace, nextManifest);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await removePath(tempDir, { recursive: true, force: true });
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) {
    throw primaryError;
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
      await moveCollectionPath(workspace.collectionDir, backupCollectionDir);
      backedUpCollection = true;
    }
    if (await exists(workspace.statsPath)) {
      await renamePath(workspace.statsPath, backupStatsPath);
      backedUpStats = true;
    }
    if (await exists(workspace.lexicalPath)) {
      await renamePath(workspace.lexicalPath, backupLexicalPath);
      backedUpLexical = true;
    }

    await moveCollectionPath(tempWorkspace.collectionDir, workspace.collectionDir, { allowSourceRemain: true });
    if (await exists(tempWorkspace.lexicalPath)) {
      await renamePath(tempWorkspace.lexicalPath, workspace.lexicalPath);
    } else {
      await removePath(workspace.lexicalPath, { force: true });
    }
    await renamePath(tempWorkspace.statsPath, workspace.statsPath);
    await saveManifest(workspace, nextManifest);

    await Promise.all([
      removePath(backupCollectionDir, { recursive: true, force: true }),
      removePath(backupLexicalPath, { force: true }),
      removePath(backupStatsPath, { force: true })
    ]);
  } catch (error) {
    await Promise.all([
      removePath(workspace.collectionDir, { recursive: true, force: true }),
      removePath(workspace.lexicalPath, { force: true }),
      removePath(workspace.statsPath, { force: true })
    ]);
    if (backedUpCollection) {
      await moveCollectionPath(backupCollectionDir, workspace.collectionDir).catch(() => undefined);
    }
    if (backedUpStats) {
      await renamePath(backupStatsPath, workspace.statsPath).catch(() => undefined);
    }
    if (backedUpLexical) {
      await renamePath(backupLexicalPath, workspace.lexicalPath).catch(() => undefined);
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
    branches: {},
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

function isWorkspaceRelativePath(relativePath: string): boolean {
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("../") && !path.isAbsolute(relativePath));
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
