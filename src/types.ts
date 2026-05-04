export const SCHEMA_VERSION = 1;
export const DEFAULT_MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
export const DEFAULT_MODEL_DIM = 768;

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
    strategy: "heading" | "fixed" | "sentence";
  };
  mcp: {
    citations: "safe" | "full-path";
    destructive_tools: "disabled" | "enabled";
  };
}

export interface UserConfig {
  init: {
    root_preference: "current" | "git-root";
  };
}

export type SourceEntry = WorkspaceSourceEntry | ExternalImportSourceEntry | SessionMemorySourceEntry;

export interface WorkspaceSourceEntry {
  path: string;
  kind: "workspace";
  include: string[];
  exclude: string[];
  no_gitignore?: boolean;
}

export interface ExternalImportSourceEntry {
  path: string;
  kind: "external_import";
  include: string[];
  exclude: string[];
  no_gitignore?: boolean;
  original_path: string;
  imported_at: string;
}

export interface SessionMemorySourceEntry {
  path: string;
  kind: "session_memory";
  include: string[];
  exclude: string[];
  no_gitignore?: boolean;
  retention_days: number;
  created_at: string;
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
  content_id?: string;
  text: string;
  source: string;
  human_source: string;
  citation_source: string;
  source_origin: "workspace" | "external_import" | "session_memory";
  chunk_idx: number;
  mtime: number;
  tags: string;
}

export interface EmbeddedChunkRecord extends ChunkRecord {
  embedding: number[];
}

export interface IndexedFileStats {
  mtime: number;
  size?: number;
  chunks: number;
  relative_path?: string;
  branch_scope?: string;
  branch_name?: string;
  git_head?: string;
  content_hash?: string;
}

export interface IndexStats {
  schema_version: number;
  model: string;
  dim: number;
  last_ingest_at: string;
  branches?: Record<string, {
    name: string;
    git_head: string;
    last_ingest_at: string;
  }>;
  files: Record<string, IndexedFileStats>;
}

export interface SearchHit {
  id: string;
  content_id?: string;
  source: string;
  citation_source: string;
  chunk_idx: number;
  score: number;
  text: string;
  snippet?: string;
  match: "vector" | "lexical" | "hybrid";
  branch_scope?: string;
  branch_name?: string;
  git_head?: string;
  content_hash?: string;
}

export interface ChunkDetail {
  id: string;
  text: string;
  source: string;
  citation_source: string;
  chunk_idx: number;
  mtime: number;
}
