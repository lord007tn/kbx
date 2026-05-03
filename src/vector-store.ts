import { mkdir } from "node:fs/promises";
import zvec, {
  type ZVecCollection,
  type ZVecCollectionSchema as ZVecCollectionSchemaType,
  type ZVecDoc,
  type ZVecStatus
} from "@zvec/zvec";
import { chunkId } from "./chunk";
import { parseChunkTags } from "./chunk-tags";
import type { ChunkDetail, ChunkRecord, EmbeddedChunkRecord, SearchHit } from "./types";
import type { Workspace } from "./workspace";

const {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecLogType,
  ZVecMetricType,
  ZVecOpen,
  isZVecError
} = zvec;

let initialized = false;
const ZVEC_BATCH_SIZE = 512;

export class ChunkVectorStore {
  private readonly collection: ZVecCollection;

  private constructor(collection: ZVecCollection) {
    this.collection = collection;
  }

  static async open(workspace: Workspace, dim: number, options: { readOnly?: boolean } = {}): Promise<ChunkVectorStore> {
    await mkdir(workspace.kbxDir, { recursive: true });
    initializeZvec(workspace);

    try {
      return new ChunkVectorStore(ZVecOpen(workspace.collectionDir, { readOnly: options.readOnly ?? false }));
    } catch (error) {
      if (options.readOnly || !isCollectionMissing(error)) {
        throw error;
      }
      return new ChunkVectorStore(ZVecCreateAndOpen(workspace.collectionDir, createSchema(dim)));
    }
  }

  get docCount(): number {
    return this.collection.stats.docCount;
  }

  upsertChunks(chunks: EmbeddedChunkRecord[]): void {
    if (chunks.length === 0) {
      return;
    }

    const contentChunks = [...new Map(chunks.map((chunk) => [chunk.content_id ?? chunk.id, chunk])).values()];
    for (let start = 0; start < contentChunks.length; start += ZVEC_BATCH_SIZE) {
      const statuses = this.collection.upsertSync(
        contentChunks.slice(start, start + ZVEC_BATCH_SIZE).map((chunk) => ({
          id: chunk.content_id ?? chunk.id,
          fields: {
            text: chunk.text,
            source: chunk.content_id ?? chunk.source,
            human_source: chunk.human_source,
            citation_source: chunk.citation_source,
            source_origin: chunk.source_origin,
            chunk_idx: chunk.chunk_idx,
            mtime: chunk.mtime,
            tags: chunk.tags
          },
          vectors: {
            embedding: chunk.embedding
          }
        }))
      );
      assertStatuses(statuses);
    }
  }

  deleteSource(source: string): void {
    const status = this.collection.deleteByFilterSync(`source = '${escapeFilterString(source)}'`);
    assertStatus(status);
  }

  existingIds(ids: string[]): Set<string> {
    if (ids.length === 0) {
      return new Set();
    }
    const existing = new Set<string>();
    for (let start = 0; start < ids.length; start += ZVEC_BATCH_SIZE) {
      const batch = ids.slice(start, start + ZVEC_BATCH_SIZE);
      for (const id of Object.keys(this.collection.fetchSync(batch))) {
        existing.add(id);
      }
    }
    return existing;
  }

  destroy(): void {
    this.collection.destroySync();
  }

  search(vector: number[], topK: number): SearchHit[] {
    const docs = this.collection.querySync({
      fieldName: "embedding",
      vector,
      topk: topK,
      outputFields: ["text", "human_source", "citation_source", "chunk_idx", "source", "tags"],
      params: {
        indexType: ZVecIndexType.HNSW,
        ef: Math.max(64, topK * 8)
      }
    });

    return docs.map(toSearchHit);
  }

  getChunk(id: string): ChunkDetail | null {
    const doc = this.collection.fetchSync(id)[id];
    if (!doc) {
      return null;
    }
    return {
      id: doc.id,
      text: String(doc.fields.text ?? ""),
      source: String(doc.fields.human_source ?? ""),
      citation_source: String(doc.fields.citation_source ?? ""),
      chunk_idx: Number(doc.fields.chunk_idx ?? 0),
      mtime: Number(doc.fields.mtime ?? 0)
    };
  }

  listSourceChunks(source: string, expectedCount: number): ChunkRecord[] {
    if (expectedCount <= 0) {
      return [];
    }

    const chunks: ChunkRecord[] = [];
    const ids = Array.from({ length: expectedCount }, (_, index) => chunkId(source, index));
    for (let start = 0; start < ids.length; start += ZVEC_BATCH_SIZE) {
      const batch = ids.slice(start, start + ZVEC_BATCH_SIZE);
      chunks.push(...Object.values(this.collection.fetchSync(batch)).map(toChunkRecord));
    }
    return chunks.sort((a, b) => a.chunk_idx - b.chunk_idx);
  }

  close(): void {
    this.collection.closeSync();
  }
}

function createSchema(dim: number): ZVecCollectionSchemaType {
  return new ZVecCollectionSchema({
    name: "kbx_chunks",
    fields: [
      { name: "text", dataType: ZVecDataType.STRING },
      { name: "source", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "human_source", dataType: ZVecDataType.STRING },
      { name: "citation_source", dataType: ZVecDataType.STRING },
      { name: "source_origin", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "chunk_idx", dataType: ZVecDataType.INT32 },
      { name: "mtime", dataType: ZVecDataType.INT64 },
      { name: "tags", dataType: ZVecDataType.STRING }
    ],
    vectors: [
      {
        name: "embedding",
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: dim,
        indexParams: {
          indexType: ZVecIndexType.HNSW,
          metricType: ZVecMetricType.COSINE
        }
      }
    ]
  });
}

function initializeZvec(workspace: Workspace): void {
  if (initialized) {
    return;
  }

  ZVecInitialize({
    logType: ZVecLogType.FILE,
    logLevel: ZVecLogLevel.WARN,
    logDir: workspace.kbxDir,
    logBaseName: "zvec.log"
  });
  initialized = true;
}

function toSearchHit(doc: ZVecDoc): SearchHit {
  const tags = parseChunkTags(String(doc.fields.tags ?? ""));
  const rawSource = String(doc.fields.source ?? "");
  const contentId = /^c[0-9a-f]{23}$/.test(rawSource) ? rawSource : undefined;
  return {
    id: doc.id,
    content_id: contentId,
    source: String(doc.fields.human_source ?? ""),
    citation_source: String(doc.fields.citation_source ?? ""),
    chunk_idx: Number(doc.fields.chunk_idx ?? 0),
    score: distanceToScore(doc.score),
    text: String(doc.fields.text ?? ""),
    match: "vector",
    branch_scope: tags.branch_scope,
    branch_name: tags.branch_name,
    git_head: tags.git_head,
    content_hash: tags.content_hash
  };
}

function toChunkRecord(doc: ZVecDoc): ChunkRecord {
  return {
    id: doc.id,
    text: String(doc.fields.text ?? ""),
    source: String(doc.fields.source ?? ""),
    human_source: String(doc.fields.human_source ?? ""),
    citation_source: String(doc.fields.citation_source ?? ""),
    source_origin: sourceOrigin(doc.fields.source_origin),
    chunk_idx: Number(doc.fields.chunk_idx ?? 0),
    mtime: Number(doc.fields.mtime ?? 0),
    tags: String(doc.fields.tags ?? "")
  };
}

function sourceOrigin(value: unknown): ChunkRecord["source_origin"] {
  return value === "external_import" || value === "session_memory" ? value : "workspace";
}

function distanceToScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance));
}

function assertStatuses(statuses: ZVecStatus | ZVecStatus[]): void {
  if (Array.isArray(statuses)) {
    for (const status of statuses) {
      assertStatus(status);
    }
    return;
  }
  assertStatus(statuses);
}

function assertStatus(status: ZVecStatus): void {
  if (!status.ok) {
    throw new Error(`Zvec operation failed: ${status.code} ${status.message}`);
  }
}

function escapeFilterString(value: string): string {
  return value.replaceAll("'", "''");
}

function isCollectionMissing(error: unknown): boolean {
  if (isZVecError(error)) {
    return error.code === "ZVEC_NOT_FOUND" || error.code === "ZVEC_INVALID_ARGUMENT";
  }
  return error instanceof Error && /not found|no such|exist/i.test(error.message);
}
