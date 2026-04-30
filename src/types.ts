export const SCHEMA_VERSION = 1;
export const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_MODEL_DIM = 384;

export interface WorkspaceManifest {
  workspace_id: string;
  name: string;
  model: string;
  dim: number;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceConfig {
  chunk: {
    size: number;
    overlap: number;
    strategy: "fixed";
  };
  mcp: {
    citations: "safe" | "full-path";
  };
}

export interface SourceEntry {
  path: string;
  kind: "workspace";
  include: string[];
  exclude: string[];
}

export interface RegistryEntry {
  workspace_id: string;
  name: string;
  path: string;
  created_at: string;
  last_seen_at: string;
}

export interface ChunkRecord {
  id: string;
  text: string;
  source: string;
  human_source: string;
  citation_source: string;
  source_origin: "workspace";
  chunk_idx: number;
  mtime: number;
  embedding: number[];
}

export interface IndexFile {
  schema_version: number;
  model: string;
  dim: number;
  last_ingest_at: string;
  chunks: ChunkRecord[];
}

export interface SearchHit {
  id: string;
  source: string;
  chunk_idx: number;
  score: number;
  text: string;
}
