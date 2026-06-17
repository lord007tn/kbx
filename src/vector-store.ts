import { mkdir, rm } from "node:fs/promises";
import zvec, {
  type ZVecCollection,
  type ZVecCollectionSchema as ZVecCollectionSchemaType,
  type ZVecDiskAnnIndexParams,
  type ZVecDiskAnnQueryParams,
  type ZVecDoc,
  type ZVecFieldSchema,
  type ZVecHnswIndexParams,
  type ZVecHnswQueryParams,
  type ZVecIndexParams,
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
const SEARCH_OUTPUT_FIELDS = ["text", "human_source", "citation_source", "chunk_idx", "source", "tags"] as const;
const CHUNK_OUTPUT_FIELDS = ["text", "human_source", "citation_source", "chunk_idx", "source", "source_origin", "mtime", "tags"] as const;

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
      return new ChunkVectorStore(await createCollection(workspace, dim));
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

  deleteContent(id: string): void {
    const status = this.collection.deleteByFilterSync(`source = '${escapeFilterString(id)}'`);
    assertStatus(status);
  }

  existingIds(ids: string[]): Set<string> {
    if (ids.length === 0) {
      return new Set();
    }
    const existing = new Set<string>();
    for (let start = 0; start < ids.length; start += ZVEC_BATCH_SIZE) {
      const batch = ids.slice(start, start + ZVEC_BATCH_SIZE);
      for (const id of Object.keys(this.collection.fetchSync({
        ids: batch,
        outputFields: [],
        includeVector: false
      }))) {
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
      outputFields: [...SEARCH_OUTPUT_FIELDS],
      includeVector: false,
      params: vectorQueryParams(this.collection, topK)
    });

    return docs.map((doc) => toSearchHit(doc, "vector", "vector_distance"));
  }

  fullTextSearch(query: string, topK: number): SearchHit[] {
    if (!hasFullTextIndex(this.collection)) {
      return [];
    }

    const docs = this.collection.querySync({
      fieldName: "text",
      fts: {
        matchString: query
      },
      topk: topK,
      outputFields: [...SEARCH_OUTPUT_FIELDS],
      includeVector: false,
      params: {
        indexType: ZVecIndexType.FTS,
        defaultOperator: "AND"
      }
    });

    return docs.map((doc) => toSearchHit(doc, "lexical", "relevance"));
  }

  hybridSearch(query: string, vector: number[], topK: number): SearchHit[] {
    if (!hasFullTextIndex(this.collection)) {
      return this.search(vector, topK);
    }

    const docs = this.collection.multiQuerySync({
      queries: [
        {
          fieldName: "embedding",
          vector,
          numCandidates: Math.max(topK * 8, 50),
          params: vectorQueryParams(this.collection, topK)
        },
        {
          fieldName: "text",
          fts: {
            matchString: query
          },
          numCandidates: Math.max(topK * 8, 50),
          params: {
            indexType: ZVecIndexType.FTS,
            defaultOperator: "AND"
          }
        }
      ],
      topk: topK,
      outputFields: [...SEARCH_OUTPUT_FIELDS],
      includeVector: false,
      rerank: {
        type: "rrf",
        rankConstant: 60
      }
    });

    return docs.map((doc) => toSearchHit(doc, "hybrid", "relevance"));
  }

  getChunk(id: string): ChunkDetail | null {
    const doc = this.collection.fetchSync({
      ids: id,
      outputFields: ["text", "human_source", "citation_source", "chunk_idx", "mtime"],
      includeVector: false
    })[id];
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
      chunks.push(...Object.values(this.collection.fetchSync({
        ids: batch,
        outputFields: [...CHUNK_OUTPUT_FIELDS],
        includeVector: false
      })).map(toChunkRecord));
    }
    return chunks.sort((a, b) => a.chunk_idx - b.chunk_idx);
  }

  close(): void {
    this.collection.closeSync();
  }
}

async function createCollection(workspace: Workspace, dim: number): Promise<ZVecCollection> {
  if (prefersDiskAnn()) {
    try {
      return ZVecCreateAndOpen(workspace.collectionDir, createSchema(dim, "diskann"));
    } catch (error) {
      if (!isDiskAnnUnsupported(error)) {
        throw error;
      }
      await rm(workspace.collectionDir, { recursive: true, force: true });
    }
  }
  return ZVecCreateAndOpen(workspace.collectionDir, createSchema(dim, "hnsw"));
}

function createSchema(dim: number, vectorIndex: "hnsw" | "diskann"): ZVecCollectionSchemaType {
  return new ZVecCollectionSchema({
    name: "kbx_chunks",
    fields: [
      { name: "text", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: "standard", filters: ["lowercase"] } },
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
        indexParams: vectorIndexParams(vectorIndex)
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

function toSearchHit(
  doc: ZVecDoc,
  match: SearchHit["match"],
  scoreMode: "vector_distance" | "relevance"
): SearchHit {
  const tags = parseChunkTags(String(doc.fields.tags ?? ""));
  const rawSource = String(doc.fields.source ?? "");
  const contentId = /^c[0-9a-f]{23}$/.test(rawSource) ? rawSource : undefined;
  return {
    id: doc.id,
    content_id: contentId,
    source: String(doc.fields.human_source ?? ""),
    citation_source: String(doc.fields.citation_source ?? ""),
    chunk_idx: Number(doc.fields.chunk_idx ?? 0),
    score: scoreMode === "vector_distance" ? distanceToScore(doc.score) : relevanceToScore(doc.score),
    text: String(doc.fields.text ?? ""),
    match,
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

function relevanceToScore(score: number): number {
  return Math.max(0, Math.min(1, score));
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

function hasFullTextIndex(collection: ZVecCollection): boolean {
  return fieldIndexType(collection.schema.field("text")) === ZVecIndexType.FTS;
}

function fieldIndexType(field: ZVecFieldSchema): ZVecIndexParams["indexType"] | undefined {
  return field.indexParams?.indexType;
}

function vectorQueryParams(collection: ZVecCollection, topK: number): ZVecHnswQueryParams | ZVecDiskAnnQueryParams {
  const indexType = collection.schema.vector("embedding").indexParams?.indexType;
  if (indexType === ZVecIndexType.DISKANN) {
    return {
      indexType: ZVecIndexType.DISKANN,
      listSize: Math.max(50, topK * 8)
    };
  }
  return {
    indexType: ZVecIndexType.HNSW,
    ef: Math.max(64, topK * 8)
  };
}

function vectorIndexParams(vectorIndex: "hnsw" | "diskann"): ZVecHnswIndexParams | ZVecDiskAnnIndexParams {
  if (vectorIndex === "diskann") {
    return {
      indexType: ZVecIndexType.DISKANN,
      metricType: ZVecMetricType.COSINE,
      maxDegree: 100,
      listSize: 50,
      pqChunkNum: 0
    };
  }
  return {
    indexType: ZVecIndexType.HNSW,
    metricType: ZVecMetricType.COSINE
  };
}

function prefersDiskAnn(): boolean {
  if (process.env.KBX_ZVEC_VECTOR_INDEX === "hnsw") {
    return false;
  }
  return process.env.KBX_ZVEC_VECTOR_INDEX === "diskann"
    || (process.platform === "linux" && process.arch === "x64");
}

function isDiskAnnUnsupported(error: unknown): boolean {
  return isZVecError(error)
    && (error.code === "ZVEC_NOT_SUPPORTED" || /diskann/i.test(error.message));
}

function isCollectionMissing(error: unknown): boolean {
  if (isZVecError(error)) {
    return error.code === "ZVEC_NOT_FOUND" || error.code === "ZVEC_INVALID_ARGUMENT";
  }
  return error instanceof Error && /not found|no such|exist/i.test(error.message);
}
