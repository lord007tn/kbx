import { createEmbedder } from "./embedding";
import { LexicalIndexStore } from "./lexical-index";
import { rerankSearchHitsWithOptionalModel } from "./retrieval";
import type { RerankerOptions } from "./reranker";
import { loadManifest, type Workspace } from "./workspace";
import type { SearchHit } from "./types";
import { ChunkVectorStore } from "./vector-store";

const RRF_K = 60;

export interface SearchWorkspaceOptions {
  reranker?: RerankerOptions;
}

export async function searchWorkspace(workspace: Workspace, query: string, topK: number, options: SearchWorkspaceOptions = {}): Promise<SearchHit[]> {
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

  const lexical = await LexicalIndexStore.open(workspace, { readOnly: true });
  let lexicalHits: SearchHit[];
  try {
    lexicalHits = lexical.search(query, Math.max(topK, topK * 2));
  } finally {
    await lexical.close();
  }
  return fuseHits(query, vectorHits, lexicalHits, topK, options);
}

async function fuseHits(query: string, vectorHits: SearchHit[], lexicalHits: SearchHit[], topK: number, options: SearchWorkspaceOptions): Promise<SearchHit[]> {
  const byId = new Map<string, SearchHit & { fusionScore: number }>();
  for (const [index, hit] of vectorHits.entries()) {
    const existing = byId.get(hit.id);
    const fusionScore = (existing?.fusionScore ?? 0) + (1 / (RRF_K + index + 1)) + hit.score;
    byId.set(hit.id, {
      ...(existing ?? hit),
      snippet: existing?.snippet ?? hit.snippet,
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
      snippet: existing?.snippet ?? hit.snippet,
      score: Math.max(existing?.score ?? 0, hit.score),
      match: existing ? "hybrid" : "lexical",
      fusionScore
    });
  }

  const fused = [...byId.values()]
    .sort((a, b) => b.fusionScore - a.fusionScore)
    .map(({ fusionScore: _fusionScore, ...hit }) => hit);

  return (await rerankSearchHitsWithOptionalModel(query, fused, options.reranker)).slice(0, topK);
}
