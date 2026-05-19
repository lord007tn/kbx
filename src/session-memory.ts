import { createId } from "@paralleldrive/cuid2";
import matter from "gray-matter";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreSessionMemoryRetention, type RetentionScore, type SessionMemoryType } from "./memory-retention";
import { normalizeSources } from "./sources";
import type { SessionMemorySourceEntry, SourceEntry } from "./types";
import { loadSources, saveSources, type Workspace } from "./workspace";

export const SESSION_MEMORY_SOURCE_PATH = ".kbx/sessions";

export interface SessionMemoryEntry {
  id: string;
  title: string;
  type: SessionMemoryType;
  created_at: string;
  expires_at: string;
  path: string;
  files: string[];
  tags: string[];
  source_chunk_ids: string[];
  supersedes: string[];
  superseded_by?: string;
  is_latest: boolean;
  retention: RetentionScore;
}

export interface AddSessionMemoryOptions {
  text: string;
  title?: string;
  type?: SessionMemoryType;
  files?: string[];
  tags?: string[];
  sourceChunkIds?: string[];
  supersedes?: string[];
  retentionDays: number;
}

export async function addSessionMemory(workspace: Workspace, options: AddSessionMemoryOptions): Promise<{
  entry: SessionMemoryEntry;
  source: SessionMemorySourceEntry;
}> {
  if (options.retentionDays < 1 || !Number.isInteger(options.retentionDays)) {
    throw new Error("Session memory retention must be a positive number of days.");
  }
  const compactText = options.text.replace(/\s+/g, " ").trim();
  if (!compactText) {
    throw new Error("Session memory text cannot be empty.");
  }

  const id = createId();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + options.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const title = sanitizeTitle(options.title ?? firstLine(compactText));
  const type = options.type ?? "fact";
  const files = compactStringList(options.files);
  const tags = compactStringList(options.tags);
  const sourceChunkIds = compactStringList(options.sourceChunkIds);
  const supersedes = compactStringList(options.supersedes);
  const sessionsDir = path.join(workspace.root, SESSION_MEMORY_SOURCE_PATH);
  await mkdir(sessionsDir, { recursive: true });

  const relativePath = `${SESSION_MEMORY_SOURCE_PATH}/${id}.md`;
  await writeFile(path.join(workspace.root, relativePath), sessionMemoryMarkdown({
    id,
    title,
    type,
    created_at: createdAt,
    expires_at: expiresAt,
    files,
    tags,
    source_chunk_ids: sourceChunkIds,
    supersedes,
    text: compactText
  }), "utf8");
  await markSupersededMemories(workspace, supersedes, id);

  const source = await ensureSessionMemorySource(workspace, options.retentionDays);
  return {
    entry: {
      id,
      title,
      type,
      created_at: createdAt,
      expires_at: expiresAt,
      path: relativePath,
      files,
      tags,
      source_chunk_ids: sourceChunkIds,
      supersedes,
      is_latest: true,
      retention: scoreSessionMemoryRetention({
        type,
        created_at: createdAt,
        expires_at: expiresAt,
        files,
        tags,
        source_chunk_ids: sourceChunkIds
      })
    },
    source
  };
}

export async function ensureSessionMemorySource(workspace: Workspace, retentionDays: number): Promise<SessionMemorySourceEntry> {
  const sources = await loadSources(workspace);
  const existing = sources.find((source): source is SessionMemorySourceEntry => source.kind === "session_memory");
  const source: SessionMemorySourceEntry = {
    path: SESSION_MEMORY_SOURCE_PATH,
    kind: "session_memory",
    include: ["**/*.md"],
    exclude: [],
    retention_days: retentionDays,
    created_at: existing?.created_at ?? new Date().toISOString()
  };
  const nextSources = normalizeSources([...sources.filter((candidate) => candidate.kind !== "session_memory"), source]);
  await saveSources(workspace, nextSources);
  return source;
}

export async function listSessionMemories(workspace: Workspace): Promise<SessionMemoryEntry[]> {
  const sessionsDir = path.join(workspace.root, SESSION_MEMORY_SOURCE_PATH);
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const entries = await Promise.all(files
    .filter((file) => file.endsWith(".md"))
    .map(async (file): Promise<SessionMemoryEntry | null> => {
      const relativePath = `${SESSION_MEMORY_SOURCE_PATH}/${file}`;
      try {
        const parsed = matter(await readFile(path.join(workspace.root, relativePath), "utf8"));
        const id = stringMatter(parsed.data.id) ?? path.basename(file, ".md");
        const title = stringMatter(parsed.data.title) ?? id;
        const type = memoryTypeMatter(parsed.data.type);
        const createdAt = stringMatter(parsed.data.created_at) ?? "";
        const expiresAt = stringMatter(parsed.data.expires_at) ?? "";
        const files = stringListMatter(parsed.data.files);
        const tags = stringListMatter(parsed.data.tags);
        const sourceChunkIds = stringListMatter(parsed.data.source_chunk_ids);
        const supersedes = stringListMatter(parsed.data.supersedes);
        const supersededBy = stringMatter(parsed.data.superseded_by) ?? undefined;
        return {
          id,
          title,
          type,
          created_at: createdAt,
          expires_at: expiresAt,
          path: relativePath,
          files,
          tags,
          source_chunk_ids: sourceChunkIds,
          supersedes,
          ...(supersededBy ? { superseded_by: supersededBy } : {}),
          is_latest: !supersededBy,
          retention: scoreSessionMemoryRetention({
            type,
            created_at: createdAt,
            expires_at: expiresAt,
            files,
            tags,
            source_chunk_ids: sourceChunkIds
          })
        };
      } catch {
        return null;
      }
    }));

  return entries
    .filter((entry): entry is SessionMemoryEntry => entry !== null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function pruneExpiredSessionMemories(workspace: Workspace, now = new Date()): Promise<SessionMemoryEntry[]> {
  const entries = await listSessionMemories(workspace);
  const expired = entries.filter((entry) => {
    const expiresAt = Date.parse(entry.expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
  });

  await Promise.all(expired.map((entry) => rm(path.join(workspace.root, entry.path), { force: true })));
  return expired;
}

export function sessionMemorySource(sources: SourceEntry[]): SessionMemorySourceEntry | null {
  return sources.find((source): source is SessionMemorySourceEntry => source.kind === "session_memory") ?? null;
}

function sessionMemoryMarkdown(input: {
  id: string;
  title: string;
  type: SessionMemoryType;
  created_at: string;
  expires_at: string;
  files: string[];
  tags: string[];
  source_chunk_ids: string[];
  supersedes: string[];
  superseded_by?: string;
  text: string;
}): string {
  const lines = [
    "---",
    `id: ${input.id}`,
    `title: ${JSON.stringify(input.title)}`,
    `type: ${input.type}`,
    `created_at: ${input.created_at}`,
    `expires_at: ${input.expires_at}`,
    `files: ${JSON.stringify(input.files)}`,
    `tags: ${JSON.stringify(input.tags)}`,
    `source_chunk_ids: ${JSON.stringify(input.source_chunk_ids)}`,
    `supersedes: ${JSON.stringify(input.supersedes)}`
  ];
  if (input.superseded_by) {
    lines.push(`superseded_by: ${input.superseded_by}`);
  }
  lines.push(
    "---",
    `# ${input.title}`,
    "",
    input.text,
    ""
  );
  return lines.join("\n");
}

async function markSupersededMemories(workspace: Workspace, supersededIds: string[], supersededBy: string): Promise<void> {
  if (supersededIds.length === 0) {
    return;
  }
  const sessionsDir = path.join(workspace.root, SESSION_MEMORY_SOURCE_PATH);
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return;
  }

  const targets = new Set(supersededIds);
  await Promise.all(files
    .filter((file) => file.endsWith(".md"))
    .map(async (file) => {
      const absolutePath = path.join(sessionsDir, file);
      try {
        const parsed = matter(await readFile(absolutePath, "utf8"));
        const id = stringMatter(parsed.data.id) ?? path.basename(file, ".md");
        if (!targets.has(id)) {
          return;
        }
        await writeFile(absolutePath, matter.stringify(parsed.content.trimStart(), {
          ...parsed.data,
          superseded_by: supersededBy
        }), "utf8");
      } catch {
        // Ignore malformed retained notes; listing will skip them too.
      }
    }));
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.slice(0, 80) || "Session memory";
}

function sanitizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120) || "Session memory";
}

function stringMatter(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

function memoryTypeMatter(value: unknown): SessionMemoryType {
  const raw = typeof value === "string" ? value : "";
  return isSessionMemoryType(raw) ? raw : "fact";
}

function isSessionMemoryType(value: string): value is SessionMemoryType {
  return ["decision", "preference", "architecture", "bug", "workflow", "fact", "handoff", "event"].includes(value);
}

function compactStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean))]
    .slice(0, 50);
}

function stringListMatter(value: unknown): string[] {
  if (Array.isArray(value)) {
    return compactStringList(value);
  }
  if (typeof value === "string" && value.trim()) {
    return compactStringList(value.split(","));
  }
  return [];
}
