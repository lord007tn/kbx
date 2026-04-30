import { mkdir } from "node:fs/promises";
import zvec, {
  type ZVecCollection,
  type ZVecCollectionSchema as ZVecCollectionSchemaType,
  type ZVecDoc,
  type ZVecStatus
} from "@zvec/zvec";
import type { ChunkDetail, EmbeddedChunkRecord, SearchHit } from "./types";
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

    const statuses = this.collection.upsertSync(
      chunks.map((chunk) => ({
        id: chunk.id,
        fields: {
          text: chunk.text,
          source: chunk.source,
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

  deleteSource(source: string): void {
    const status = this.collection.deleteByFilterSync(`source = '${escapeFilterString(source)}'`);
    assertStatus(status);
  }

  destroy(): void {
    this.collection.destroySync();
  }

  search(vector: number[], topK: number): SearchHit[] {
    const docs = this.collection.querySync({
      fieldName: "embedding",
      vector,
      topk: topK,
      outputFields: ["text", "human_source", "citation_source", "chunk_idx"],
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
  return {
    id: doc.id,
    source: String(doc.fields.human_source ?? ""),
    citation_source: String(doc.fields.citation_source ?? ""),
    chunk_idx: Number(doc.fields.chunk_idx ?? 0),
    score: distanceToScore(doc.score),
    text: String(doc.fields.text ?? "")
  };
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
