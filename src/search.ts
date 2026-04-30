import { createEmbedder } from "./embedding.js";
import { loadManifest, type Workspace } from "./workspace.js";
import type { SearchHit } from "./types.js";
import { ChunkVectorStore } from "./vector-store.js";

export async function searchWorkspace(workspace: Workspace, query: string, topK: number): Promise<SearchHit[]> {
  const manifest = await loadManifest(workspace);
  const embedder = createEmbedder(manifest.model, manifest.dim);
  const [queryEmbedding] = await embedder.embed([query]);
  if (!queryEmbedding) {
    return [];
  }

  const store = await ChunkVectorStore.open(workspace, manifest.dim, { readOnly: true });
  try {
    return store.search(queryEmbedding, topK);
  } finally {
    store.close();
  }
}
