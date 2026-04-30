import { chunkMarkdown } from "./chunk.js";
import { createEmbedder } from "./embedding.js";
import { listMarkdownFiles } from "./files.js";
import { readJson, writeJson } from "./io.js";
import { loadConfig, loadManifest, loadSources, saveSources, touchManifest, type Workspace } from "./workspace.js";
import { normalizeSources, sourceForTarget } from "./sources.js";
import { SCHEMA_VERSION, type ChunkRecord, type IndexFile } from "./types.js";

export interface IngestResult {
  files: number;
  chunks: number;
  skipped: number;
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

  const existingIndex = await loadIndexIfPresent(workspace);
  const retainedChunks = existingIndex.chunks.filter((chunk) => !chunk.source.startsWith(source.path === "." ? "" : `${source.path}/`) && chunk.source !== source.path);
  const files = await listMarkdownFiles(workspace.root, source.path);
  const embedder = createEmbedder(manifest.model, manifest.dim);
  const chunksToEmbed: Omit<ChunkRecord, "embedding">[] = [];
  let skipped = 0;

  for (const file of files) {
    const existingForFile = existingIndex.chunks.filter((chunk) => chunk.source === file.relativePath);
    if (existingForFile.length > 0 && existingForFile.every((chunk) => chunk.mtime === file.mtime)) {
      skipped += 1;
      retainedChunks.push(...existingForFile);
      continue;
    }

    const textChunks = chunkMarkdown({
      source: file.relativePath,
      content: file.content,
      maxChars: config.chunk.size,
      overlapChars: config.chunk.overlap
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
        mtime: file.mtime
      });
    }
  }

  const embeddings = chunksToEmbed.length > 0 ? await embedder.embed(chunksToEmbed.map((chunk) => chunk.text)) : [];
  const embeddedChunks = chunksToEmbed.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index] ?? []
  }));

  const nextIndex: IndexFile = {
    schema_version: SCHEMA_VERSION,
    model: manifest.model,
    dim: manifest.dim,
    last_ingest_at: new Date().toISOString(),
    chunks: [...retainedChunks, ...embeddedChunks].sort((a, b) => a.source.localeCompare(b.source) || a.chunk_idx - b.chunk_idx)
  };
  await writeJson(workspace.indexPath, nextIndex);
  await touchManifest(workspace);

  return {
    files: files.length,
    chunks: embeddedChunks.length,
    skipped
  };
}

async function loadIndexIfPresent(workspace: Workspace): Promise<IndexFile> {
  try {
    return await readJson<IndexFile>(workspace.indexPath);
  } catch {
    return {
      schema_version: SCHEMA_VERSION,
      model: "",
      dim: 0,
      last_ingest_at: "",
      chunks: []
    };
  }
}
