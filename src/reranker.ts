import { spawn } from "node:child_process";
import type { SearchHit } from "./types";
import { configureTransformersEnvironment } from "./models";

export interface RerankerOptions {
  mode?: "none" | "local" | "model" | "command";
  command?: string;
  model?: string;
  timeoutMs?: number;
}

export interface CommandRerankerRequest {
  query: string;
  candidates: Array<{
    id: string;
    source: string;
    chunk_idx: number;
    score: number;
    text: string;
  }>;
}

export type CommandRerankerResponse =
  | { scores: Record<string, number> }
  | Array<{ id: string; score: number }>;

const DEFAULT_MODEL_RERANKER = "Xenova/all-MiniLM-L6-v2";

export async function applyOptionalReranker(query: string, hits: SearchHit[], options: RerankerOptions = {}): Promise<SearchHit[]> {
  const mode = options.mode ?? process.env.KBX_RERANKER as RerankerOptions["mode"] ?? "none";
  if (mode === "none" || hits.length < 2) {
    return hits;
  }
  if (mode === "local") {
    return hits;
  }
  if (mode === "model") {
    const scores = await runModelReranker(query, hits, options.model ?? process.env.KBX_RERANK_MODEL ?? DEFAULT_MODEL_RERANKER);
    return sortByScores(hits, scores);
  }
  if (mode !== "command") {
    throw new Error(`Unknown reranker mode "${mode}". Supported modes: none, local, model, command.`);
  }

  const command = options.command ?? process.env.KBX_RERANK_COMMAND;
  if (!command) {
    throw new Error("KBX_RERANK_COMMAND is required when reranker mode is command.");
  }

  const scores = await runCommandReranker(command, {
    query,
    candidates: hits.map((hit) => ({
      id: hit.id,
      source: hit.source,
      chunk_idx: hit.chunk_idx,
      score: hit.score,
      text: hit.text
    }))
  }, options.timeoutMs);

  return sortByScores(hits, scores);
}

export async function runCommandReranker(
  commandLine: string,
  request: CommandRerankerRequest,
  timeoutMs = Number.parseInt(process.env.KBX_RERANK_TIMEOUT_MS ?? "30000", 10)
): Promise<Map<string, number>> {
  const [command, ...args] = parseCommandLine(commandLine);
  if (!command) {
    throw new Error("Reranker command is empty.");
  }

  const stdout = await runProcess(command, args, `${JSON.stringify(request)}\n`, timeoutMs);
  const parsed = JSON.parse(stdout) as CommandRerankerResponse;
  const scores = new Map<string, number>();

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry.id === "string" && Number.isFinite(entry.score)) {
        scores.set(entry.id, entry.score);
      }
    }
    return scores;
  }

  for (const [id, score] of Object.entries(parsed.scores ?? {})) {
    if (Number.isFinite(score)) {
      scores.set(id, score);
    }
  }
  return scores;
}

export async function runModelReranker(
  query: string,
  candidates: CommandRerankerRequest["candidates"],
  model = process.env.KBX_RERANK_MODEL ?? DEFAULT_MODEL_RERANKER
): Promise<Map<string, number>> {
  if (model === "hash") {
    return hashRerankerScores(query, candidates);
  }

  const { pipeline } = await configureTransformersEnvironment();
  const extractor = await pipeline("feature-extraction", model);
  const queryVector = await embedWithExtractor(extractor, query);
  const scores = new Map<string, number>();
  for (const candidate of candidates) {
    const candidateVector = await embedWithExtractor(extractor, `${candidate.source}\n${candidate.text}`);
    scores.set(candidate.id, cosineSimilarity(queryVector, candidateVector));
  }
  return scores;
}

export function parseCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const next = value[index + 1];
    if (char === "\\" && next && (next === "\\" || next === "\"" || next === "'" || /\s/.test(next))) {
      current += next;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new Error("Unterminated quote in command line.");
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function sortByScores(hits: SearchHit[], scores: Map<string, number>): SearchHit[] {
  return [...hits]
    .map((hit, index) => ({
      hit,
      rankScore: scores.get(hit.id) ?? Number.NEGATIVE_INFINITY,
      originalIndex: index
    }))
    .sort((a, b) => b.rankScore - a.rankScore || a.originalIndex - b.originalIndex)
    .map((entry) => entry.hit);
}

async function embedWithExtractor(extractor: unknown, text: string): Promise<number[]> {
  const output = await (extractor as FeatureExtractor)(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Iterable<number>);
}

type FeatureExtractor = (text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Iterable<number> }>;

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aMagnitude += av * av;
    bMagnitude += bv * bv;
  }
  if (aMagnitude === 0 || bMagnitude === 0) {
    return 0;
  }
  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function hashRerankerScores(query: string, candidates: CommandRerankerRequest["candidates"]): Map<string, number> {
  const terms = query.toLowerCase().match(/[a-z0-9_.:-]+/g) ?? [];
  const scores = new Map<string, number>();
  for (const candidate of candidates) {
    const haystack = `${candidate.source}\n${candidate.text}`.toLowerCase();
    scores.set(candidate.id, terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0));
  }
  return scores;
}

function runProcess(command: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Reranker command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Reranker command exited with ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(stdin);
  });
}
