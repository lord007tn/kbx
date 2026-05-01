import { spawn } from "node:child_process";
import type { SearchHit } from "./types";

export interface RerankerOptions {
  mode?: "none" | "command";
  command?: string;
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

export async function applyOptionalReranker(query: string, hits: SearchHit[], options: RerankerOptions = {}): Promise<SearchHit[]> {
  const mode = options.mode ?? process.env.KBX_RERANKER as RerankerOptions["mode"] ?? "none";
  if (mode === "none" || hits.length < 2) {
    return hits;
  }
  if (mode !== "command") {
    throw new Error(`Unknown reranker mode "${mode}". Supported modes: none, command.`);
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

  return [...hits]
    .map((hit, index) => ({
      hit,
      rankScore: scores.get(hit.id) ?? Number.NEGATIVE_INFINITY,
      originalIndex: index
    }))
    .sort((a, b) => b.rankScore - a.rankScore || a.originalIndex - b.originalIndex)
    .map((entry) => entry.hit);
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
