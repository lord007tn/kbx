import { createId } from "@paralleldrive/cuid2";
import matter from "gray-matter";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeSources } from "./sources";
import type { SessionMemorySourceEntry, SourceEntry } from "./types";
import { loadSources, saveSources, type Workspace } from "./workspace";

export const SESSION_MEMORY_SOURCE_PATH = ".kbx/sessions";

export interface SessionMemoryEntry {
  id: string;
  title: string;
  created_at: string;
  expires_at: string;
  path: string;
}

export interface AddSessionMemoryOptions {
  text: string;
  title?: string;
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
  const sessionsDir = path.join(workspace.root, SESSION_MEMORY_SOURCE_PATH);
  await mkdir(sessionsDir, { recursive: true });

  const relativePath = `${SESSION_MEMORY_SOURCE_PATH}/${id}.md`;
  await writeFile(path.join(workspace.root, relativePath), sessionMemoryMarkdown({
    id,
    title,
    created_at: createdAt,
    expires_at: expiresAt,
    text: compactText
  }), "utf8");

  const source = await ensureSessionMemorySource(workspace, options.retentionDays);
  return {
    entry: {
      id,
      title,
      created_at: createdAt,
      expires_at: expiresAt,
      path: relativePath
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
        const createdAt = stringMatter(parsed.data.created_at) ?? "";
        const expiresAt = stringMatter(parsed.data.expires_at) ?? "";
        return {
          id,
          title,
          created_at: createdAt,
          expires_at: expiresAt,
          path: relativePath
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
  created_at: string;
  expires_at: string;
  text: string;
}): string {
  return `---\nid: ${input.id}\ntitle: ${JSON.stringify(input.title)}\ncreated_at: ${input.created_at}\nexpires_at: ${input.expires_at}\n---\n# ${input.title}\n\n${input.text}\n`;
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
