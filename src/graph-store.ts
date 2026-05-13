import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LexicalIndexStore } from "./lexical-index";
import type { ChunkRecord } from "./types";
import { loadConfig, type Workspace } from "./workspace";

const GRAPH_SCHEMA_VERSION = 1;

export interface GraphNode {
  id: string;
  type: "file" | "heading" | "symbol" | "package" | "memory";
  label: string;
  aliases: string;
  source: string | null;
  first_seen_chunk_id: string | null;
}

export interface GraphEdge {
  id: string;
  from_id: string;
  to_id: string;
  relation: "contains" | "defines" | "depends_on" | "records";
  source: string | null;
  chunk_id: string | null;
  weight: number;
}

export interface GraphBuildResult {
  chunks_scanned: number;
  nodes: number;
  edges: number;
}

export interface GraphQueryResult {
  query: string;
  nodes: Array<GraphNode & { edges: Array<GraphEdge & { from_label: string; to_label: string }> }>;
}

interface NodeRow extends GraphNode {}
interface EdgeRow extends GraphEdge {}

export async function buildGraph(workspace: Workspace, options: { maxChunks?: number } = {}): Promise<GraphBuildResult> {
  const config = await loadConfig(workspace);
  const maxChunks = options.maxChunks ?? config.graph.max_chunks;
  const lexical = await LexicalIndexStore.open(workspace, { readOnly: true });
  const db = openGraphDb(workspace);
  try {
    const chunks = lexical.allChunks(maxChunks);
    const graph = extractGraph(chunks);
    const insertNode = db.prepare(`
      INSERT INTO graph_nodes (id, type, label, aliases, source, first_seen_chunk_id)
      VALUES (@id, @type, @label, @aliases, @source, @first_seen_chunk_id)
      ON CONFLICT(id) DO UPDATE SET
        aliases = excluded.aliases,
        source = COALESCE(graph_nodes.source, excluded.source),
        first_seen_chunk_id = COALESCE(graph_nodes.first_seen_chunk_id, excluded.first_seen_chunk_id)
    `);
    const insertEdge = db.prepare(`
      INSERT OR IGNORE INTO graph_edges (id, from_id, to_id, relation, source, chunk_id, weight)
      VALUES (@id, @from_id, @to_id, @relation, @source, @chunk_id, @weight)
    `);
    const transaction = db.transaction(() => {
      db.exec("DELETE FROM graph_edges; DELETE FROM graph_nodes;");
      for (const node of graph.nodes.values()) {
        insertNode.run(node);
      }
      for (const edge of graph.edges.values()) {
        insertEdge.run(edge);
      }
    });
    transaction();
    return {
      chunks_scanned: chunks.length,
      nodes: graph.nodes.size,
      edges: graph.edges.size
    };
  } finally {
    await lexical.close();
    db.close();
  }
}

export async function queryGraph(workspace: Workspace, query: string, options: { limit?: number } = {}): Promise<GraphQueryResult> {
  const db = openGraphDb(workspace);
  try {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const terms = graphTerms(query);
    const clauses = terms.map(() => "(lower(label) LIKE ? ESCAPE '\\' OR lower(aliases) LIKE ? ESCAPE '\\' OR lower(type) LIKE ? ESCAPE '\\')");
    const params = terms.flatMap((term) => {
      const like = `%${escapeLike(term)}%`;
      return [like, like, like];
    });
    const rows = db.prepare(`
      SELECT id, type, label, aliases, source, first_seen_chunk_id
      FROM graph_nodes
      ${clauses.length > 0 ? `WHERE ${clauses.join(" OR ")}` : ""}
      ORDER BY type, label
      LIMIT ?
    `).all(...params, limit) as NodeRow[];
    const edgeStmt = db.prepare(`
      SELECT
        e.id,
        e.from_id,
        e.to_id,
        e.relation,
        e.source,
        e.chunk_id,
        e.weight,
        from_node.label AS from_label,
        to_node.label AS to_label
      FROM graph_edges e
      JOIN graph_nodes from_node ON from_node.id = e.from_id
      JOIN graph_nodes to_node ON to_node.id = e.to_id
      WHERE e.from_id = ? OR e.to_id = ?
      ORDER BY e.weight DESC, e.relation, to_label
      LIMIT 20
    `);
    return {
      query,
      nodes: rows.map((node) => ({
        ...node,
        edges: edgeStmt.all(node.id, node.id) as Array<GraphEdge & { from_label: string; to_label: string }>
      }))
    };
  } finally {
    db.close();
  }
}

export async function graphStats(workspace: Workspace): Promise<{ nodes: number; edges: number; by_type: Record<string, number> }> {
  const db = openGraphDb(workspace);
  try {
    const nodes = (db.prepare("SELECT COUNT(*) AS count FROM graph_nodes").get() as { count: number }).count;
    const edges = (db.prepare("SELECT COUNT(*) AS count FROM graph_edges").get() as { count: number }).count;
    const byTypeRows = db.prepare("SELECT type, COUNT(*) AS count FROM graph_nodes GROUP BY type ORDER BY type").all() as Array<{ type: string; count: number }>;
    return {
      nodes,
      edges,
      by_type: Object.fromEntries(byTypeRows.map((row) => [row.type, row.count]))
    };
  } finally {
    db.close();
  }
}

function openGraphDb(workspace: Workspace): Database.Database {
  mkdirSync(workspace.kbxDir, { recursive: true });
  const db = new Database(workspace.graphPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const userVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (userVersion > GRAPH_SCHEMA_VERSION) {
    throw new Error(`Unsupported graph schema ${userVersion}. Upgrade kbx to read this workspace.`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '',
      source TEXT,
      first_seen_chunk_id TEXT
    );
    CREATE INDEX IF NOT EXISTS graph_nodes_lookup_idx ON graph_nodes(type, label);

    CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      source TEXT,
      chunk_id TEXT,
      weight REAL NOT NULL DEFAULT 1,
      FOREIGN KEY (from_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS graph_edges_from_idx ON graph_edges(from_id);
    CREATE INDEX IF NOT EXISTS graph_edges_to_idx ON graph_edges(to_id);
  `);
  db.pragma(`user_version = ${GRAPH_SCHEMA_VERSION}`);
}

function extractGraph(chunks: ChunkRecord[]): { nodes: Map<string, GraphNode>; edges: Map<string, GraphEdge> } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (type: GraphNode["type"], label: string, chunk: ChunkRecord, aliases: string[] = []): GraphNode => {
    const cleanLabel = normalizeLabel(label);
    const id = graphId("node", type, cleanLabel.toLowerCase());
    const existing = nodes.get(id);
    if (existing) {
      const mergedAliases = [...new Set([...existing.aliases.split("\n").filter(Boolean), ...aliases])].sort();
      existing.aliases = mergedAliases.join("\n");
      return existing;
    }
    const node: GraphNode = {
      id,
      type,
      label: cleanLabel,
      aliases: [...new Set(aliases)].sort().join("\n"),
      source: chunk.human_source,
      first_seen_chunk_id: chunk.id
    };
    nodes.set(id, node);
    return node;
  };
  const addEdge = (from: GraphNode, to: GraphNode, relation: GraphEdge["relation"], chunk: ChunkRecord, weight = 1): void => {
    const id = graphId("edge", from.id, relation, to.id, chunk.id);
    edges.set(id, {
      id,
      from_id: from.id,
      to_id: to.id,
      relation,
      source: chunk.human_source,
      chunk_id: chunk.id,
      weight
    });
  };

  for (const chunk of chunks) {
    const fileNode = addNode("file", chunk.human_source, chunk, [chunk.source, chunk.citation_source]);
    for (const heading of extractHeadings(chunk.text)) {
      const headingNode = addNode("heading", `${chunk.human_source} > ${heading}`, chunk, [heading]);
      addEdge(fileNode, headingNode, "contains", chunk, 0.8);
    }
    for (const symbol of extractSymbols(chunk.text)) {
      const symbolNode = addNode("symbol", symbol, chunk, [`${chunk.human_source}#${symbol}`]);
      addEdge(fileNode, symbolNode, "defines", chunk, 0.9);
    }
    for (const packageName of extractPackageDependencies(chunk)) {
      const packageNode = addNode("package", packageName, chunk);
      addEdge(fileNode, packageNode, "depends_on", chunk, 0.7);
    }
    if (chunk.source_origin === "session_memory") {
      const memoryLabel = extractMemoryLabel(chunk);
      const memoryNode = addNode("memory", memoryLabel, chunk, [
        chunk.human_source,
        chunk.text.replace(/\s+/g, " ").trim().slice(0, 500)
      ]);
      addEdge(fileNode, memoryNode, "records", chunk, 1);
    }
  }
  return { nodes, edges };
}

function extractHeadings(text: string): string[] {
  const headings = new Set<string>();
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const value = match[1]?.replace(/#+$/, "").trim();
    if (value) {
      headings.add(value);
    }
  }
  return [...headings];
}

function extractSymbols(text: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
    /\b(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
    /\b(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
    /\b(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
    /\b(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        symbols.add(match[1]);
      }
    }
  }
  return [...symbols];
}

function extractPackageDependencies(chunk: ChunkRecord): string[] {
  if (path.basename(chunk.human_source) !== "package.json") {
    return [];
  }
  try {
    const parsed = JSON.parse(chunk.text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [...new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
      ...Object.keys(parsed.optionalDependencies ?? {})
    ])].sort();
  } catch {
    return [];
  }
}

function extractMemoryLabel(chunk: ChunkRecord): string {
  const heading = extractHeadings(chunk.text)[0];
  if (heading) {
    return heading;
  }
  return chunk.text.replace(/\s+/g, " ").trim().slice(0, 120) || chunk.human_source;
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function graphTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_.:/-]+/g) ?? [])].filter((term) => term.length > 1);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function graphId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}
