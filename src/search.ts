import { createEmbedder } from "./embedding.js";
import { readJson } from "./io.js";
import { loadManifest, type Workspace } from "./workspace.js";
import type { IndexFile, SearchHit } from "./types.js";

export async function searchWorkspace(workspace: Workspace, query: string, topK: number): Promise<SearchHit[]> {
  const manifest = await loadManifest(workspace);
  const index = await readJson<IndexFile>(workspace.indexPath);
  if (index.model !== manifest.model || index.dim !== manifest.dim) {
    throw new Error("Index model does not match workspace manifest. Re-run kbx ingest.");
  }

  const embedder = createEmbedder(manifest.model, manifest.dim);
  const [queryEmbedding] = await embedder.embed([query]);
  if (!queryEmbedding) {
    return [];
  }

  return index.chunks
    .map((chunk) => ({
      id: chunk.id,
      source: chunk.human_source,
      chunk_idx: chunk.chunk_idx,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
      text: chunk.text
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    aMagnitude += left * left;
    bMagnitude += right * right;
  }

  if (aMagnitude === 0 || bMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}
