import { createEmbedder } from "./embedding";
import { branchIndexExists, currentBranchContext } from "./branch";
import { loadIndexStats } from "./indexer";
import { LexicalIndexStore } from "./lexical-index";
import { rerankSearchHitsWithOptionalModel } from "./retrieval";
import type { RerankerOptions } from "./reranker";
import { loadManifest, loadRegistry, type Workspace, workspaceFromRoot } from "./workspace";
import type { SearchHit } from "./types";
import { ChunkVectorStore } from "./vector-store";
import { access } from "node:fs/promises";
import path from "node:path";

const RRF_K = 60;

export interface SearchWorkspaceOptions {
  reranker?: RerankerOptions;
}

export interface GlobalSearchHit extends SearchHit {
  workspace: {
    id: string;
    name: string;
    path: string;
  };
  local_source: string;
}

export async function searchWorkspace(workspace: Workspace, query: string, topK: number, options: SearchWorkspaceOptions = {}): Promise<SearchHit[]> {
  const manifest = await loadManifest(workspace);
  const branch = await currentBranchContext(workspace.root);
  const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
  const branchScope = branch?.scope;
  const filterToBranch = branchIndexExists(stats.files, branchScope);
  const embedder = createEmbedder(manifest.model, manifest.dim);
  const [queryEmbedding] = await embedder.embed([query]);
  if (!queryEmbedding) {
    return [];
  }

  const store = await ChunkVectorStore.open(workspace, manifest.dim, { readOnly: true });
  let vectorHits: SearchHit[];
  try {
    vectorHits = branchFilter(store.search(queryEmbedding, Math.max(topK * 12, 50)), branchScope, filterToBranch);
  } finally {
    store.close();
  }

  const lexical = await LexicalIndexStore.open(workspace, { readOnly: true });
  let lexicalHits: SearchHit[];
  try {
    lexicalHits = branchFilter(lexical.search(query, Math.max(topK * 12, 50)), branchScope, filterToBranch);
  } finally {
    await lexical.close();
  }
  return fuseHits(query, vectorHits, lexicalHits, topK, options);
}

function branchFilter(hits: SearchHit[], branchScope: string | undefined, enabled: boolean): SearchHit[] {
  if (!enabled || !branchScope) {
    return hits;
  }
  return hits.filter((hit) => hit.branch_scope === branchScope);
}

export async function searchRegisteredWorkspaces(
  query: string,
  topK: number,
  options: SearchWorkspaceOptions = {}
): Promise<GlobalSearchHit[]> {
  const hits: GlobalSearchHit[] = [];
  for (const entry of await loadRegistry()) {
    const workspace = workspaceFromRoot(entry.path);
    if (!await exists(workspace.kbxDir)) {
      continue;
    }

    try {
      const workspaceHits = await searchWorkspace(workspace, query, topK, options);
      hits.push(...workspaceHits.map((hit) => ({
        ...hit,
        workspace: {
          id: entry.workspace_id,
          name: entry.name,
          path: entry.path
        },
        local_source: hit.source,
        source: `${entry.name}:${hit.source}`,
        citation_source: `${entry.name}:${hit.citation_source}`
      })));
    } catch {
      // A missing or corrupt workspace should not make global discovery unusable.
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || a.workspace.name.localeCompare(b.workspace.name) || a.local_source.localeCompare(b.local_source))
    .slice(0, topK);
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(path.resolve(filePath));
    return true;
  } catch {
    return false;
  }
}
