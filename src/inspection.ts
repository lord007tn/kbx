import { access } from "node:fs/promises";
import path from "node:path";
import { currentBranchContext } from "./branch";
import { graphStats } from "./graph-store";
import { loadIndexStats, scanWorkspaceFreshness } from "./indexer";
import { LexicalIndexStore } from "./lexical-index";
import { searchWorkspace } from "./search";
import { listSessionMemories } from "./session-memory";
import type { IndexStats, SourceEntry } from "./types";
import { loadConfig, loadManifest, loadSources, type Workspace } from "./workspace";

const DEFAULT_PREVIEW_CHARS = 360;

export async function buildFileContext(
  workspace: Workspace,
  files: string[],
  terms: string[],
  topK: number,
  options: { includeSupersededMemories?: boolean } = {}
) {
  const config = await loadConfig(workspace);
  const normalizedFiles = [...new Set(files.map(normalizeMemoryPath))];
  const query = [...normalizedFiles, ...normalizedFiles.map((file) => path.basename(file)), ...terms].join(" ");
  const [hits, memories] = await Promise.all([
    searchWorkspace(workspace, query, topK),
    listSessionMemories(workspace)
  ]);
  const linkedMemories = memories
    .filter((memory) => (options.includeSupersededMemories === true || memory.is_latest)
      && memory.files.some((file) => normalizedFiles.some((target) => pathsOverlap(file, target))))
    .sort((a, b) => Number(b.is_latest) - Number(a.is_latest) || b.retention.score - a.retention.score || b.created_at.localeCompare(a.created_at));

  return {
    files: normalizedFiles,
    terms,
    linked_memories: linkedMemories,
    search_results: hits.map((hit) => ({
      id: hit.id,
      source: config.mcp.citations === "safe" ? hit.citation_source : hit.source,
      chunk_idx: hit.chunk_idx,
      score: hit.score,
      match: hit.match,
      ...(hit.branch_name ? { branch: hit.branch_name } : {}),
      preview: previewForHit(hit, DEFAULT_PREVIEW_CHARS)
    })),
    next: "Use kbx_search expand_ids or kbx_get_chunk for full text from specific results."
  };
}

export async function buildWorkspaceInspection(
  workspace: Workspace,
  options: { sourceLimit: number; memoryLimit: number }
) {
  const [manifest, config, sources, stats, branch, freshness, memories, graph] = await Promise.all([
    loadManifest(workspace),
    loadConfig(workspace),
    loadSources(workspace),
    loadManifest(workspace).then((m) => loadIndexStats(workspace, m.model, m.dim)),
    currentBranchContext(workspace.root),
    scanWorkspaceFreshness(workspace).catch((error) => ({
      error: "freshness_scan_failed",
      detail: error instanceof Error ? error.message : String(error)
    })),
    listSessionMemories(workspace),
    graphStatsIfPresent(workspace)
  ]);

  return {
    workspace: {
      id: manifest.workspace_id,
      name: manifest.name,
      path: workspace.root
    },
    model: {
      id: manifest.model,
      dim: manifest.dim
    },
    config: {
      citations: config.mcp.citations,
      sessions_capture: config.sessions.capture,
      graph_enabled: config.graph.enabled,
      watch_auto: config.watch.auto
    },
    branch: branch ? {
      name: branch.name,
      head: branch.head,
      scope: branch.scope
    } : null,
    index: {
      files: Object.keys(stats.files).length,
      chunks: totalIndexedChunks(stats),
      last_ingest_at: stats.last_ingest_at || null,
      freshness
    },
    sources: sources.map(sourceSummary),
    recent_sources: recentIndexedSources(stats, options.sourceLimit),
    memories: {
      total: memories.length,
      latest: memories.filter((memory) => memory.is_latest).length,
      superseded: memories.filter((memory) => !memory.is_latest).length,
      by_type: countBy(memories.map((memory) => memory.type)),
      by_tier: countBy(memories.map((memory) => memory.retention.tier)),
      recent: memories
        .sort((a, b) => Number(b.is_latest) - Number(a.is_latest) || b.created_at.localeCompare(a.created_at))
        .slice(0, options.memoryLimit)
    },
    graph
  };
}

export async function buildMemoryVerification(workspace: Workspace, memoryId: string) {
  const [config, memories] = await Promise.all([
    loadConfig(workspace),
    listSessionMemories(workspace)
  ]);
  const memory = resolveMemoryId(memories, memoryId);
  const lexical = await LexicalIndexStore.open(workspace, { readOnly: true });
  try {
    const citations = [];
    const missing_source_chunk_ids = [];
    for (const id of memory.source_chunk_ids) {
      const chunk = lexical.getChunk(id);
      if (!chunk) {
        missing_source_chunk_ids.push(id);
        continue;
      }
      citations.push({
        id: chunk.id,
        source: config.mcp.citations === "safe" ? chunk.citation_source : chunk.human_source,
        citation_source: chunk.citation_source,
        chunk_idx: chunk.chunk_idx,
        preview: excerpt(chunk.text, DEFAULT_PREVIEW_CHARS)
      });
    }

    return {
      status: verificationStatus(memory.source_chunk_ids.length, citations.length),
      memory,
      citations,
      missing_source_chunk_ids,
      next: citations.length > 0
        ? "Use kbx_get_chunk with a citation id for full source text."
        : "Add source_chunk_ids when saving important retained memories so later verification can trace them to indexed context."
    };
  } finally {
    await lexical.close();
  }
}

export async function buildMemoryHistory(workspace: Workspace, memoryId: string) {
  const memories = await listSessionMemories(workspace);
  const memory = resolveMemoryId(memories, memoryId);
  const byId = new Map(memories.map((entry) => [entry.id, entry]));
  const descendantsById = new Map<string, typeof memories>();
  for (const entry of memories) {
    for (const parentId of entry.supersedes) {
      const siblings = descendantsById.get(parentId) ?? [];
      siblings.push(entry);
      descendantsById.set(parentId, siblings);
    }
  }

  const ancestors = collectAncestors(memory, byId);
  const descendants = collectDescendants(memory, descendantsById);
  const chain = [...ancestors, memory, ...descendants]
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const latest = chain.filter((entry) => entry.is_latest);

  return {
    memory,
    ancestors,
    descendants,
    chain,
    latest,
    summary: {
      chain_length: chain.length,
      ancestors: ancestors.length,
      descendants: descendants.length,
      latest: latest.length,
      superseded: chain.filter((entry) => !entry.is_latest).length
    },
    next: "Use kbx_memory_verify or kbx memory verify on a chain entry to inspect supporting chunk citations."
  };
}

function totalIndexedChunks(stats: IndexStats): number {
  return Object.values(stats.files).reduce((total, file) => total + file.chunks, 0);
}

function recentIndexedSources(stats: IndexStats, limit: number) {
  return Object.entries(stats.files)
    .map(([source, file]) => ({
      source: file.relative_path ?? source,
      chunks: file.chunks,
      mtime: file.mtime,
      ...(file.branch_name ? { branch: file.branch_name } : {}),
      ...(file.git_head ? { git_head: file.git_head } : {})
    }))
    .sort((a, b) => b.mtime - a.mtime || a.source.localeCompare(b.source))
    .slice(0, limit);
}

function sourceSummary(source: SourceEntry) {
  return {
    path: source.path,
    kind: source.kind,
    include: source.include,
    exclude: source.exclude,
    ...(source.kind === "external_import" ? {
      original_path: source.original_path,
      imported_at: source.imported_at
    } : {}),
    ...(source.kind === "session_memory" ? {
      retention_days: source.retention_days,
      created_at: source.created_at
    } : {})
  };
}

async function graphStatsIfPresent(workspace: Workspace) {
  try {
    await access(workspace.graphPath);
  } catch {
    return null;
  }
  try {
    return await graphStats(workspace);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function normalizeMemoryPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function pathsOverlap(a: string, b: string): boolean {
  const left = normalizeMemoryPath(a).toLowerCase();
  const right = normalizeMemoryPath(b).toLowerCase();
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function excerpt(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 3))}...` : compact;
}

function previewForHit(hit: { text: string; snippet?: string }, maxChars: number): string {
  return excerpt(hit.snippet ?? hit.text, maxChars);
}

function resolveMemoryId<T extends { id: string }>(memories: T[], requestedId: string): T {
  const exact = memories.find((memory) => memory.id === requestedId);
  if (exact) {
    return exact;
  }
  const matches = memories.filter((memory) => memory.id.startsWith(requestedId));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Memory id prefix is ambiguous: ${requestedId}`);
  }
  throw new Error(`Memory not found: ${requestedId}`);
}

function collectAncestors<T extends { id: string; supersedes: string[] }>(memory: T, byId: Map<string, T>): T[] {
  const visited = new Set<string>();
  const ancestors: T[] = [];
  const visit = (entry: T): void => {
    for (const parentId of entry.supersedes) {
      if (visited.has(parentId)) {
        continue;
      }
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) {
        continue;
      }
      visit(parent);
      ancestors.push(parent);
    }
  };
  visit(memory);
  return ancestors;
}

function collectDescendants<T extends { id: string; created_at: string }>(memory: T, descendantsById: Map<string, T[]>): T[] {
  const visited = new Set<string>();
  const descendants: T[] = [];
  const visit = (entry: T): void => {
    const children = [...(descendantsById.get(entry.id) ?? [])]
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const child of children) {
      if (visited.has(child.id)) {
        continue;
      }
      visited.add(child.id);
      descendants.push(child);
      visit(child);
    }
  };
  visit(memory);
  return descendants;
}

function verificationStatus(total: number, found: number): "verified" | "partial" | "missing_sources" | "uncited" {
  if (total === 0) {
    return "uncited";
  }
  if (found === total) {
    return "verified";
  }
  if (found > 0) {
    return "partial";
  }
  return "missing_sources";
}
