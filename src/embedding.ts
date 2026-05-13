import crypto from "node:crypto";
import { configureTransformersEnvironment } from "./models";
import { DEFAULT_MODEL_DIM, DEFAULT_MODEL_ID } from "./types";

export interface Embedder {
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export function createEmbedder(model = DEFAULT_MODEL_ID, dim = DEFAULT_MODEL_DIM): Embedder {
  if (model === "hash" || process.env.KBX_EMBEDDER === "hash") {
    return new HashEmbedder(model, dim);
  }
  return new TransformersEmbedder(model, dim);
}

class TransformersEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private extractor: Promise<unknown> | null = null;

  constructor(model: string, dim: number) {
    this.model = model;
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.loadExtractor();
    const results: number[][] = [];

    for (const text of texts) {
      const output = await (extractor as CallableExtractor)(text, { pooling: "mean", normalize: true });
      const values = Array.from(output.data as Iterable<number>);
      results.push(values.slice(0, this.dim));
    }

    return results;
  }

  private async loadExtractor(): Promise<unknown> {
    this.extractor ??= configureTransformersEnvironment().then(({ pipeline }) => {
      return pipeline("feature-extraction", this.model);
    });
    return this.extractor;
  }
}

type CallableExtractor = (text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Iterable<number> }>;

class HashEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;

  constructor(model: string, dim: number) {
    this.model = model;
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => normalize(hashVector(text, this.dim)));
  }
}

function hashVector(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

  for (const token of tokens) {
    const digest = crypto.createHash("sha256").update(token).digest();
    const offset = digest.readUInt32BE(0) % dim;
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    vector[offset] = (vector[offset] ?? 0) + sign;
  }

  return vector;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}
