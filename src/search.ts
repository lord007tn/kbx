import { readFile } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown, chunkText } from "./chunk";
import { createEmbedder } from "./embedding";
import { loadConfig, loadManifest, loadSources, type Workspace } from "./workspace";
import { loadIndexStats } from "./indexer";
import type { SearchHit, SourceEntry } from "./types";
import { ChunkVectorStore } from "./vector-store";

const LEXICAL_SCAN_CONCURRENCY = 32;
const RRF_K = 60;

export async function searchWorkspace(workspace: Workspace, query: string, topK: number): Promise<SearchHit[]> {
  const manifest = await loadManifest(workspace);
  const embedder = createEmbedder(manifest.model, manifest.dim);
  const [queryEmbedding] = await embedder.embed([query]);
  if (!queryEmbedding) {
    return [];
  }

  const store = await ChunkVectorStore.open(workspace, manifest.dim, { readOnly: true });
  let vectorHits: SearchHit[];
  try {
    vectorHits = store.search(queryEmbedding, Math.max(topK, topK * 2));
  } finally {
    store.close();
  }

  const lexicalHits = await lexicalSearchWorkspace(workspace, query, Math.max(topK, topK * 2));
  return fuseHits(vectorHits, lexicalHits, topK);
}

async function lexicalSearchWorkspace(workspace: Workspace, query: string, topK: number): Promise<SearchHit[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [];
  }

  const manifest = await loadManifest(workspace);
  const [config, stats, sources] = await Promise.all([
    loadConfig(workspace),
    loadIndexStats(workspace, manifest.model, manifest.dim),
    loadSources(workspace)
  ]);
  const indexedFiles = Object.keys(stats.files);
  const candidates = await mapConcurrent(indexedFiles, LEXICAL_SCAN_CONCURRENCY, async (relativePath) => {
    let content: string;
    try {
      content = await readFile(path.join(workspace.root, relativePath), "utf8");
    } catch {
      return [];
    }

    const extension = path.extname(relativePath).toLowerCase();
    const isMarkdown = extension === ".md" || extension === ".mdx";
    const chunks = isMarkdown && config.chunk.strategy === "heading"
      ? chunkMarkdown({
          source: relativePath,
          content,
          maxChars: config.chunk.size,
          overlapChars: config.chunk.overlap
        })
      : chunkText({
          source: relativePath,
          content,
          maxChars: config.chunk.size,
          overlapChars: config.chunk.overlap,
          stripFrontmatter: isMarkdown
        });

    return chunks
      .map((chunk): SearchHit & { lexicalScore: number } => {
        const lexicalScore = scoreLexicalHit(query, terms, relativePath, chunk.text);
        const source = sourceForFile(sources, relativePath);
        return {
          id: chunk.id,
          source: humanSource(source, relativePath),
          citation_source: citationSource(source, relativePath),
          chunk_idx: chunk.chunk_idx,
          score: lexicalScore,
          text: chunk.text,
          match: "lexical",
          lexicalScore
        };
      })
      .filter((hit) => hit.lexicalScore > 0);
  });

  return candidates
    .flat()
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .slice(0, topK)
    .map(({ lexicalScore: _lexicalScore, ...hit }) => hit);
}

function fuseHits(vectorHits: SearchHit[], lexicalHits: SearchHit[], topK: number): SearchHit[] {
  const byId = new Map<string, SearchHit & { fusionScore: number }>();
  for (const [index, hit] of vectorHits.entries()) {
    const existing = byId.get(hit.id);
    const fusionScore = (existing?.fusionScore ?? 0) + (1 / (RRF_K + index + 1)) + hit.score;
    byId.set(hit.id, {
      ...(existing ?? hit),
      score: Math.max(existing?.score ?? 0, hit.score),
      match: existing && existing.match !== "vector" ? "hybrid" : "vector",
      fusionScore
    });
  }

  for (const [index, hit] of lexicalHits.entries()) {
    const existing = byId.get(hit.id);
    const fusionScore = (existing?.fusionScore ?? 0) + (1 / (RRF_K + index + 1)) + hit.score;
    byId.set(hit.id, {
      ...(existing ?? hit),
      score: Math.max(existing?.score ?? 0, hit.score),
      match: existing ? "hybrid" : "lexical",
      fusionScore
    });
  }

  return [...byId.values()]
    .sort((a, b) => b.fusionScore - a.fusionScore)
    .slice(0, topK)
    .map(({ fusionScore: _fusionScore, ...hit }) => hit);
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_.:-]+/g) ?? [])]
    .filter((term) => term.length > 1);
}

function scoreLexicalHit(query: string, terms: string[], source: string, text: string): number {
  const haystack = `${source}\n${text}`.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  let score = haystack.includes(normalizedQuery) ? 1 : 0;
  let matchedTerms = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      matchedTerms += 1;
      score += source.toLowerCase().includes(term) ? 0.25 : 0.12;
    }
  }
  if (matchedTerms === 0) {
    return 0;
  }
  return Math.min(1, score + matchedTerms / Math.max(terms.length, 1) * 0.5);
}

function sourceForFile(sources: SourceEntry[], filePath: string): SourceEntry | undefined {
  return sources
    .filter((source) => source.path === filePath || source.path === "." || filePath.startsWith(`${source.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function humanSource(source: SourceEntry | undefined, filePath: string): string {
  if (!source || source.kind !== "external_import") {
    return filePath;
  }
  const relative = relativeToSource(source.path, filePath);
  return `${source.original_path}${relative ? `/${relative}` : ""}`;
}

function citationSource(source: SourceEntry | undefined, filePath: string): string {
  if (!source || source.kind !== "external_import") {
    return filePath;
  }
  const relative = relativeToSource(source.path, filePath);
  return `external:${relative || "."}`;
}

function relativeToSource(sourcePath: string, filePath: string): string {
  return filePath === sourcePath ? "" : filePath.slice(sourcePath.length + 1);
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
