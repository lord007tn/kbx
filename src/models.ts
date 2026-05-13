import { access, cp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "./io";
import { userKbxDir } from "./workspace";

export interface ModelCatalogEntry {
  id: string;
  model: string;
  dim: number;
  size: string;
  profile: "fast" | "balanced" | "quality";
  accuracy: "good" | "better" | "best";
  speed: "fastest" | "fast" | "moderate" | "slow";
  memory: "low" | "medium" | "high";
  languages: string;
  bestFor: string;
  description: string;
}

export interface ModelBenchmarkResult {
  model: string;
  dim: number;
  platform: string;
  arch: string;
  measured_at: string;
  samples: number;
  elapsed_ms: number;
  chunks_per_second: number;
}

interface ModelBenchmarkCache {
  schema_version: 1;
  results: Record<string, ModelBenchmarkResult>;
}

type TransformersModule = typeof import("@huggingface/transformers");

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "hash",
    model: "hash",
    dim: 384,
    size: "0 MB",
    profile: "fast",
    accuracy: "good",
    speed: "fastest",
    memory: "low",
    languages: "Token-based",
    bestFor: "Very fast local indexing for large code workspaces",
    description: "Deterministic local hash embeddings with no model download"
  },
  {
    id: "minilm",
    model: "Xenova/all-MiniLM-L6-v2",
    dim: 384,
    size: "~23 MB",
    profile: "fast",
    accuracy: "good",
    speed: "fastest",
    memory: "low",
    languages: "English",
    bestFor: "Small notes, fast local indexing, older laptops",
    description: "Smallest download and fastest CPU ingest"
  },
  {
    id: "nomic",
    model: "nomic-ai/nomic-embed-text-v1.5",
    dim: 768,
    size: "~137 MB",
    profile: "balanced",
    accuracy: "better",
    speed: "fast",
    memory: "medium",
    languages: "Multilingual",
    bestFor: "Default choice for most workspaces",
    description: "Better retrieval quality with still-reasonable CPU cost"
  },
  {
    id: "bge-base",
    model: "Xenova/bge-base-en-v1.5",
    dim: 768,
    size: "~438 MB",
    profile: "quality",
    accuracy: "better",
    speed: "moderate",
    memory: "medium",
    languages: "English",
    bestFor: "English-heavy docs where retrieval quality matters more than ingest speed",
    description: "English-focused retrieval quality"
  },
  {
    id: "qwen3-0.6b",
    model: "Qwen/Qwen3-Embedding-0.6B",
    dim: 1024,
    size: "~600 MB+",
    profile: "quality",
    accuracy: "best",
    speed: "slow",
    memory: "high",
    languages: "Multilingual",
    bestFor: "Quality experiments on machines with enough RAM",
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

export function modelDetails(model: ModelCatalogEntry): string {
  return [
    `${model.accuracy} accuracy`,
    model.size,
    `${model.dim}d`,
    `${model.speed} CPU`,
    `${model.memory} memory`,
    model.languages
  ].join(" | ");
}

export function modelBenchmarkCachePath(): string {
  return path.join(userKbxDir(), "model-benchmarks.json");
}

export async function loadModelBenchmarkCache(): Promise<ModelBenchmarkCache> {
  try {
    return await readJson<ModelBenchmarkCache>(modelBenchmarkCachePath());
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    return emptyBenchmarkCache();
  }
}

export async function saveModelBenchmarkResult(result: ModelBenchmarkResult): Promise<void> {
  const cache = await loadModelBenchmarkCache();
  cache.results[benchmarkCacheKey(result.model, result.dim)] = result;
  await writeJson(modelBenchmarkCachePath(), cache);
}

export async function cachedModelBenchmark(model: string, dim: number): Promise<ModelBenchmarkResult | undefined> {
  const cache = await loadModelBenchmarkCache();
  return cache.results[benchmarkCacheKey(model, dim)];
}

export function benchmarkCacheKey(model: string, dim: number): string {
  return `${process.platform}:${process.arch}:${model}:${dim}`;
}

export function formatBenchmarkSpeed(result: ModelBenchmarkResult | undefined, fallback: string): string {
  if (!result) {
    return fallback;
  }
  return `${result.chunks_per_second.toFixed(result.chunks_per_second >= 10 ? 0 : 1)}/s`;
}

export async function isCatalogModelInstalled(model: ModelCatalogEntry): Promise<boolean> {
  if (model.model === "hash") {
    return true;
  }
  const cacheDir = await transformersCacheDir();
  if (!cacheDir) {
    return false;
  }

  const modelDir = path.join(cacheDir, ...model.model.split("/"));
  if (!(await exists(path.join(modelDir, "config.json")))) {
    return false;
  }
  return hasFileWithExtension(path.join(modelDir, "onnx"), ".onnx");
}

export async function loadCatalogModelFromPath(model: ModelCatalogEntry, sourcePath: string): Promise<string> {
  const source = path.resolve(sourcePath);
  const sourceInfo = await stat(source);
  if (!sourceInfo.isDirectory()) {
    throw new Error(`${source} is not a model directory.`);
  }
  if (!(await exists(path.join(source, "config.json")))) {
    throw new Error(`${source} does not contain config.json.`);
  }
  if (!(await hasFileWithExtension(path.join(source, "onnx"), ".onnx"))) {
    throw new Error(`${source} does not contain an ONNX model under onnx/.`);
  }

  const cacheDir = await transformersCacheDir();
  if (!cacheDir) {
    throw new Error("Transformers.js filesystem cache is unavailable in this environment.");
  }

  const destination = path.join(cacheDir, ...model.model.split("/"));
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  return destination;
}

export async function configureTransformersEnvironment(): Promise<TransformersModule> {
  const module = await import("@huggingface/transformers");
  module.env.cacheDir = process.env.KBX_MODEL_CACHE
    ? path.resolve(process.env.KBX_MODEL_CACHE)
    : path.join(userKbxDir(), "models");
  return module;
}

async function transformersCacheDir(): Promise<string | null> {
  const { env } = await configureTransformersEnvironment();
  return env.cacheDir;
}

async function hasFileWithExtension(directory: string, extension: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(extension)) {
      return true;
    }
    if (entry.isDirectory() && await hasFileWithExtension(entryPath, extension)) {
      return true;
    }
  }
  return false;
}

function emptyBenchmarkCache(): ModelBenchmarkCache {
  return {
    schema_version: 1,
    results: {}
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
