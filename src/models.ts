export interface ModelCatalogEntry {
  id: string;
  model: string;
  dim: number;
  size: string;
  profile: "fast" | "balanced" | "quality";
  description: string;
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "minilm",
    model: "Xenova/all-MiniLM-L6-v2",
    dim: 384,
    size: "~23 MB",
    profile: "fast",
    description: "Smallest download and fastest CPU ingest"
  },
  {
    id: "nomic",
    model: "nomic-ai/nomic-embed-text-v1.5",
    dim: 768,
    size: "~137 MB",
    profile: "balanced",
    description: "Better retrieval quality with still-reasonable CPU cost"
  },
  {
    id: "bge-base",
    model: "Xenova/bge-base-en-v1.5",
    dim: 768,
    size: "TBD",
    profile: "quality",
    description: "English-focused retrieval quality"
  },
  {
    id: "qwen3-0.6b",
    model: "Qwen/Qwen3-Embedding-0.6B",
    dim: 1024,
    size: "TBD",
    profile: "quality",
    description: "Highest quality candidate that may still run on CPU"
  }
];

export function resolveModel(id: string): ModelCatalogEntry {
  const model = MODEL_CATALOG.find((entry) => entry.id === id || entry.model === id);
  if (!model) {
    throw new Error(`Unknown model "${id}". Run kbx model list.`);
  }
  return model;
}
