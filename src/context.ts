import { loadConfig, type Workspace } from "./workspace";
import { searchWorkspace, type SearchWorkspaceOptions } from "./search";

export interface WorkspaceContextHit {
  id: string;
  source: string;
  chunk_idx: number;
  score: number;
  match: "vector" | "lexical" | "graph" | "hybrid";
  text: string;
  branch?: string;
}

export interface WorkspaceContext {
  query: string;
  hits: WorkspaceContextHit[];
  maxChars: number;
}

export interface WorkspaceContextOptions extends SearchWorkspaceOptions {
  topK?: number;
  maxChars?: number;
  citationMode?: "safe" | "full-path";
}

const DEFAULT_CONTEXT_TOP_K = 8;
const DEFAULT_CONTEXT_MAX_CHARS = 16000;

export async function buildWorkspaceContext(
  workspace: Workspace,
  query: string,
  options: WorkspaceContextOptions = {}
): Promise<WorkspaceContext> {
  const [hits, config] = await Promise.all([
    searchWorkspace(workspace, query, options.topK ?? DEFAULT_CONTEXT_TOP_K, {
      reranker: options.reranker
    }),
    loadConfig(workspace)
  ]);
  const citationMode = options.citationMode ?? config.mcp.citations;

  return {
    query,
    maxChars: options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS,
    hits: hits.map((hit) => ({
      id: hit.id,
      source: citationMode === "safe" ? hit.citation_source : hit.source,
      chunk_idx: hit.chunk_idx,
      score: hit.score,
      match: hit.match,
      text: hit.text,
      ...(hit.branch_name ? { branch: hit.branch_name } : {})
    }))
  };
}

export function formatWorkspaceContextMarkdown(context: WorkspaceContext): string {
  const lines: string[] = [
    "# kbx context",
    "",
    `Query: ${context.query}`,
    `Results: ${context.hits.length}`,
    ""
  ];

  let used = lines.join("\n").length;
  let truncated = false;
  const bySource = new Map<string, WorkspaceContextHit[]>();
  for (const hit of context.hits) {
    const group = bySource.get(hit.source) ?? [];
    group.push(hit);
    bySource.set(hit.source, group);
  }

  for (const [source, hits] of bySource) {
    if (used >= context.maxChars) {
      truncated = true;
      break;
    }

    const sourceHeader = [`## ${source}`, ""];
    appendWithinBudget(lines, sourceHeader, context.maxChars, () => {
      truncated = true;
    });
    used = lines.join("\n").length;

    for (const hit of hits) {
      if (used >= context.maxChars) {
        truncated = true;
        break;
      }

      const heading = [
        `### chunk ${hit.chunk_idx} (${hit.match}, ${hit.score.toFixed(3)}${hit.branch ? `, ${hit.branch}` : ""})`,
        "",
        "```text"
      ];
      appendWithinBudget(lines, heading, context.maxChars, () => {
        truncated = true;
      });
      const beforeText = lines.join("\n").length;
      const remaining = context.maxChars - beforeText - "\n```\n".length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const text = hit.text.trim();
      if (text.length > remaining) {
        lines.push(`${text.slice(0, Math.max(0, remaining - 20)).trimEnd()}\n... truncated ...`);
        truncated = true;
      } else {
        lines.push(text);
      }
      lines.push("```", "");
      used = lines.join("\n").length;
    }
  }

  if (truncated) {
    lines.push("> Context truncated by max_chars. Increase --max-chars if you need more.");
  }

  return lines.join("\n").trimEnd();
}

function appendWithinBudget(lines: string[], next: string[], maxChars: number, onTruncated: () => void): void {
  const current = lines.join("\n").length;
  const nextText = next.join("\n");
  if (current + nextText.length + 1 <= maxChars) {
    lines.push(...next);
    return;
  }
  onTruncated();
}
