import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ChunkRecord, SearchHit } from "./types";
import { readJson } from "./io";
import { parseChunkTags } from "./chunk-tags";
import { lexicalEnhancementScore, queryTerms, snippetForQuery } from "./retrieval";
import type { Workspace } from "./workspace";

const LEXICAL_SCHEMA_VERSION = 3;
const FUZZY_TERM_LIMIT = 2000;

interface LexicalIndexFile {
  schema_version: number;
  chunks: ChunkRecord[];
}

interface ChunkRow {
  id: string;
  content_id: string;
  text: string;
  source: string;
  human_source: string;
  citation_source: string;
  source_origin: "workspace" | "external_import" | "session_memory";
  chunk_idx: number;
  mtime: number;
  tags: string;
}

interface CandidateRow extends ChunkRow {
  bm25_score: number | null;
  layer: "fts" | "trigram" | "like";
}

export class LexicalIndexStore {
  private constructor(
    private readonly db: Database.Database,
    private readonly readOnly: boolean
  ) {}

  static async open(workspace: Workspace, options: { readOnly?: boolean } = {}): Promise<LexicalIndexStore> {
    mkdirSync(workspace.kbxDir, { recursive: true });
    const db = new Database(workspace.lexicalPath);
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");

    const store = new LexicalIndexStore(db, options.readOnly === true);
    store.migrate();
    if (!store.readOnly) {
      await store.migrateLegacyJson(workspace);
    }
    return store;
  }

  get chunkCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count;
  }

  get contentCount(): number {
    return (this.db.prepare("SELECT COUNT(DISTINCT content_id) AS count FROM chunks").get() as { count: number }).count;
  }

  sourceChunkCount(source: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE source = ?").get(source) as { count: number }).count;
  }

  contentIdsForSource(source: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT content_id FROM chunks WHERE source = ?").all(source) as Array<{ content_id: string }>;
    return rows.map((row) => row.content_id).filter(Boolean);
  }

  hasContent(contentId: string): boolean {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE content_id = ?").get(contentId) as { count: number }).count > 0;
  }

  upsertChunks(chunks: ChunkRecord[]): void {
    this.assertWritable();
    if (chunks.length === 0) {
      return;
    }

    const deleteTerms = this.db.prepare("DELETE FROM chunk_terms WHERE chunk_id = ?");
    const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE id = ?");
    const deleteTrigram = this.db.prepare("DELETE FROM chunks_trigram WHERE id = ?");
    const deleteChunk = this.db.prepare("DELETE FROM chunks WHERE id = ?");
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (
        id, content_id, text, source, human_source, citation_source, source_origin, chunk_idx, mtime, tags
      ) VALUES (
        @id, @content_id, @text, @source, @human_source, @citation_source, @source_origin, @chunk_idx, @mtime, @tags
      )
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO chunks_fts (id, text, source, human_source, tags)
      VALUES (@id, @text, @source, @human_source, @tags)
    `);
    const insertTrigram = this.db.prepare(`
      INSERT INTO chunks_trigram (id, text, source, human_source)
      VALUES (@id, @text, @source, @human_source)
    `);
    const insertTerm = this.db.prepare("INSERT OR IGNORE INTO chunk_terms (term, chunk_id) VALUES (?, ?)");
    const transaction = this.db.transaction((records: ChunkRecord[]) => {
      for (const chunk of records) {
        const row = {
          ...chunk,
          content_id: chunk.content_id ?? chunk.id
        };
        deleteTerms.run(chunk.id);
        deleteFts.run(chunk.id);
        deleteTrigram.run(chunk.id);
        deleteChunk.run(chunk.id);
        insertChunk.run(row);
        insertFts.run(row);
        insertTrigram.run(row);
        for (const term of lexicalTerms(`${chunk.source}\n${chunk.human_source}\n${chunk.text}`)) {
          insertTerm.run(term, chunk.id);
        }
      }
    });
    transaction(chunks);
  }

  deleteSource(source: string): void {
    this.assertWritable();
    const ids = this.db.prepare("SELECT id FROM chunks WHERE source = ?").all(source) as Array<{ id: string }>;
    const transaction = this.db.transaction((chunkIds: Array<{ id: string }>) => {
      for (const { id } of chunkIds) {
        this.deleteChunk(id);
      }
    });
    transaction(ids);
  }

  search(query: string, topK: number): SearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0 || topK <= 0) {
      return [];
    }

    const limit = Math.max(topK * 4, 20);
    const candidates = new Map<string, { chunk: ChunkRecord; score: number }>();
    for (const row of this.searchFts(query, terms, limit)) {
      const score = scoreLexicalHit(query, terms, row) + bm25Boost(row.bm25_score, row.layer);
      this.mergeCandidate(candidates, row, score);
    }
    for (const row of this.searchLike(query, terms, limit)) {
      const score = scoreLexicalHit(query, terms, row) + 0.03;
      this.mergeCandidate(candidates, row, score);
    }
    for (const row of this.searchFuzzy(terms, limit)) {
      const score = scoreLexicalHit(query, terms, row) + 0.18;
      this.mergeCandidate(candidates, row, score);
    }

    return [...candidates.values()]
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.source.localeCompare(b.chunk.source) || a.chunk.chunk_idx - b.chunk.chunk_idx)
      .slice(0, topK)
      .map(({ chunk, score }) => toSearchHit(chunk, score, query));
  }

  getChunk(id: string): ChunkRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        content_id,
        text,
        source,
        human_source,
        citation_source,
        source_origin,
        chunk_idx,
        mtime,
        tags
      FROM chunks
      WHERE id = ?
    `).get(id) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  aliasesForContent(contentId: string, branchScope: string | undefined, limit: number): SearchHit[] {
    const rows = this.db.prepare(`
      SELECT
        id,
        content_id,
        text,
        source,
        human_source,
        citation_source,
        source_origin,
        chunk_idx,
        mtime,
        tags
      FROM chunks
      WHERE content_id = ?
      ORDER BY source, chunk_idx
      LIMIT ?
    `).all(contentId, Math.max(limit * 20, 200)) as ChunkRow[];

    return rows
      .map(rowToChunk)
      .filter((chunk) => branchScope === undefined || parseChunkTags(chunk.tags).branch_scope === branchScope)
      .slice(0, limit)
      .map((chunk) => toSearchHit(chunk, 0, ""));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private migrate(): void {
    const userVersion = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (userVersion > LEXICAL_SCHEMA_VERSION) {
      throw new Error(`Unsupported lexical index schema ${userVersion}. Upgrade kbx to read this workspace.`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        human_source TEXT NOT NULL,
        citation_source TEXT NOT NULL,
        source_origin TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        tags TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks(source);
      CREATE INDEX IF NOT EXISTS chunks_content_idx ON chunks(content_id);
      CREATE TABLE IF NOT EXISTS chunk_terms (
        term TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        PRIMARY KEY (term, chunk_id),
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS chunk_terms_chunk_idx ON chunk_terms(chunk_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        id UNINDEXED,
        text,
        source,
        human_source,
        tags,
        tokenize = 'unicode61 tokenchars ''_./:-'''
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        id UNINDEXED,
        text,
        source,
        human_source,
        tokenize = 'trigram'
      );
      PRAGMA user_version = ${LEXICAL_SCHEMA_VERSION};
    `);
    this.ensureContentIdColumn();
  }

  private async migrateLegacyJson(workspace: Workspace): Promise<void> {
    if (this.chunkCount > 0) {
      return;
    }

    const legacyPath = path.join(workspace.kbxDir, "lexical-index.json");
    let index: LexicalIndexFile;
    try {
      index = await readJson<LexicalIndexFile>(legacyPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      return;
    }
    if (!Array.isArray(index.chunks)) {
      return;
    }
    this.upsertChunks(index.chunks);
  }

  private searchFts(query: string, terms: string[], limit: number): CandidateRow[] {
    const rows: CandidateRow[] = [];
    const ftsQuery = buildFtsQuery(query, terms);
    if (ftsQuery) {
      rows.push(...this.searchFtsTable("chunks_fts", ftsQuery, "fts", limit));
    }

    const trigramTerms = terms.filter((term) => term.length >= 3);
    if (trigramTerms.length > 0) {
      rows.push(...this.searchFtsTable("chunks_trigram", trigramTerms.map((term) => `"${escapeFtsPhrase(term)}"`).join(" OR "), "trigram", limit));
    }
    return rows;
  }

  private searchFtsTable(tableName: "chunks_fts" | "chunks_trigram", matchQuery: string, layer: "fts" | "trigram", limit: number): CandidateRow[] {
    try {
      return this.db.prepare(`
        SELECT
          c.id,
          c.content_id,
          c.text,
          c.source,
          c.human_source,
          c.citation_source,
          c.source_origin,
          c.chunk_idx,
          c.mtime,
          c.tags,
          bm25(${tableName}) AS bm25_score,
          ? AS layer
        FROM ${tableName}
        JOIN chunks c ON c.id = ${tableName}.id
        WHERE ${tableName} MATCH ?
        ORDER BY bm25(${tableName})
        LIMIT ?
      `).all(layer, matchQuery, limit) as CandidateRow[];
    } catch (error) {
      if (error instanceof Error && /fts5|syntax|parse/i.test(error.message)) {
        return [];
      }
      throw error;
    }
  }

  private searchLike(query: string, terms: string[], limit: number): CandidateRow[] {
    const phrase = query.toLowerCase().trim();
    const clauses: string[] = [];
    const params: string[] = [];
    if (phrase.length > 1) {
      clauses.push("(lower(text) LIKE ? ESCAPE '\\' OR lower(source) LIKE ? ESCAPE '\\' OR lower(human_source) LIKE ? ESCAPE '\\')");
      const value = `%${escapeLike(phrase)}%`;
      params.push(value, value, value);
    }
    for (const term of terms) {
      clauses.push("(lower(text) LIKE ? ESCAPE '\\' OR lower(source) LIKE ? ESCAPE '\\' OR lower(human_source) LIKE ? ESCAPE '\\')");
      const value = `%${escapeLike(term)}%`;
      params.push(value, value, value);
    }
    if (clauses.length === 0) {
      return [];
    }

    return this.db.prepare(`
      SELECT
        id,
        content_id,
        text,
        source,
        human_source,
        citation_source,
        source_origin,
        chunk_idx,
        mtime,
        tags,
        NULL AS bm25_score,
        'like' AS layer
      FROM chunks
      WHERE ${clauses.join(" OR ")}
      LIMIT ?
    `).all(...params, limit) as CandidateRow[];
  }

  private searchFuzzy(terms: string[], limit: number): CandidateRow[] {
    const replacements = new Set<string>();
    const selectTerms = this.db.prepare(`
      SELECT DISTINCT term
      FROM chunk_terms
      WHERE length(term) BETWEEN ? AND ?
        AND substr(term, 1, 1) = ?
      LIMIT ?
    `);

    for (const term of terms.filter((candidate) => candidate.length >= 4)) {
      const maxDistance = Math.max(1, Math.floor(term.length / 4));
      const rows = selectTerms.all(
        Math.max(1, term.length - maxDistance),
        term.length + maxDistance,
        term[0],
        FUZZY_TERM_LIMIT
      ) as Array<{ term: string }>;
      for (const row of rows) {
        if (row.term !== term && levenshteinWithin(term, row.term, maxDistance)) {
          replacements.add(row.term);
        }
      }
    }

    if (replacements.size === 0) {
      return [];
    }

    const values = [...replacements].slice(0, 20);
    const placeholders = values.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT DISTINCT
        c.id,
        c.content_id,
        c.text,
        c.source,
        c.human_source,
        c.citation_source,
        c.source_origin,
        c.chunk_idx,
        c.mtime,
        c.tags,
        NULL AS bm25_score,
        'like' AS layer
      FROM chunk_terms t
      JOIN chunks c ON c.id = t.chunk_id
      WHERE t.term IN (${placeholders})
      LIMIT ?
    `).all(...values, limit) as CandidateRow[];
  }

  private mergeCandidate(
    candidates: Map<string, { chunk: ChunkRecord; score: number }>,
    row: CandidateRow,
    score: number
  ): void {
    const existing = candidates.get(row.id);
    candidates.set(row.id, {
      chunk: rowToChunk(row),
      score: Math.max(existing?.score ?? 0, score)
    });
  }

  private deleteChunk(id: string): void {
    this.db.prepare("DELETE FROM chunk_terms WHERE chunk_id = ?").run(id);
    this.db.prepare("DELETE FROM chunks_fts WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM chunks_trigram WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new Error("Cannot mutate read-only lexical index.");
    }
  }

  private ensureContentIdColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "content_id")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN content_id TEXT NOT NULL DEFAULT '';");
    }
    this.db.exec(`
      UPDATE chunks SET content_id = id WHERE content_id = '';
      CREATE INDEX IF NOT EXISTS chunks_content_idx ON chunks(content_id);
    `);
  }
}

function toSearchHit(chunk: ChunkRecord, score: number, query: string): SearchHit {
  const tags = parseChunkTags(chunk.tags);
  return {
    id: chunk.id,
    content_id: chunk.content_id ?? chunk.id,
    source: chunk.human_source,
    citation_source: chunk.citation_source,
    chunk_idx: chunk.chunk_idx,
    score: Math.min(1, score),
    text: chunk.text,
    snippet: snippetForQuery(chunk.text, query, 360),
    match: "lexical",
    branch_scope: tags.branch_scope,
    branch_name: tags.branch_name,
    git_head: tags.git_head,
    content_hash: tags.content_hash
  };
}

function rowToChunk(row: ChunkRow): ChunkRecord {
  return {
    id: row.id,
    content_id: row.content_id || row.id,
    text: row.text,
    source: row.source,
    human_source: row.human_source,
    citation_source: row.citation_source,
    source_origin: row.source_origin,
    chunk_idx: row.chunk_idx,
    mtime: row.mtime,
    tags: row.tags
  };
}

function scoreLexicalHit(query: string, terms: string[], chunk: ChunkRecord | ChunkRow): number {
  return lexicalEnhancementScore({
    query,
    terms,
    source: `${chunk.source}\n${chunk.human_source}`,
    text: chunk.text
  });
}

function bm25Boost(rank: number | null, layer: "fts" | "trigram" | "like"): number {
  if (rank === null) {
    return 0;
  }
  const normalized = 1 / (1 + Math.max(0, rank + 20));
  return normalized * (layer === "fts" ? 0.15 : 0.08);
}

function buildFtsQuery(query: string, terms: string[]): string {
  const clauses: string[] = [];
  const phrase = query.toLowerCase().trim();
  if (phrase.length > 1 && terms.length > 1) {
    clauses.push(`"${escapeFtsPhrase(phrase)}"`);
  }
  for (const term of terms) {
    clauses.push(`"${escapeFtsPhrase(term)}"`);
  }
  return [...new Set(clauses)].join(" OR ");
}

function escapeFtsPhrase(value: string): string {
  return value.replaceAll('"', '""');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function lexicalTerms(value: string): string[] {
  const normalized = value.toLowerCase();
  return [...new Set([
    ...(normalized.match(/[a-z0-9_.:-]+/g) ?? []),
    ...(normalized.match(/[a-z0-9]+/g) ?? [])
  ])].filter((term) => term.length > 1);
}

function levenshteinWithin(left: string, right: string, maxDistance: number): boolean {
  if (Math.abs(left.length - right.length) > maxDistance) {
    return false;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0]!;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const next = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost
      );
      current[j] = next;
      rowMin = Math.min(rowMin, next);
    }
    if (rowMin > maxDistance) {
      return false;
    }
    previous = current;
  }
  return previous[right.length]! <= maxDistance;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
