import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KBX_AGENT_GUIDE, KBX_MCP_INSTRUCTIONS } from "./agent-guide";
import { generateAdapterConfig, listAdapters } from "./adapters";
import { currentBranchContext } from "./branch";
import { buildWorkspaceContext, formatWorkspaceContextMarkdown } from "./context";
import { runDoctor } from "./doctor";
import { buildGraph, graphStats, queryGraph } from "./graph-store";
import {
  deleteWorkspaceKnowledgeBase,
  forgetWorkspace,
  loadConfig,
  loadManifest,
  loadSources,
  type Workspace
} from "./workspace";
import {
  ingestSource,
  loadIndexStats,
  refreshWorkspaceFreshness,
  refreshWorkspaceFile,
  refreshWorkspaceIndex,
  removeSource,
  resetWorkspaceIndex,
  scanWorkspaceFreshness
} from "./indexer";
import { searchRegisteredWorkspaces, searchWorkspace } from "./search";
import { addSessionMemory, listSessionMemories, sessionMemorySource } from "./session-memory";
import {
  addSessionCheckpoint,
  appendSessionEvent,
  applySessionRewind,
  getSession,
  listSessionEvents,
  listSessions,
  previewSessionRewind,
  sessionTimeline
} from "./session-store";
import { LexicalIndexStore } from "./lexical-index";
import { KBX_VERSION } from "./version";
import type { IndexStats, SourceEntry } from "./types";
import { watchStatus } from "./watch";

const DEFAULT_SEARCH_PREVIEW_CHARS = 360;
const MCP_SEARCH_AUTO_REFRESH_MAX_CHANGES = 25;
const sessionEventTypeSchema = z.enum(["prompt", "assistant", "tool", "file_edit", "checkpoint", "note", "error", "other"]);

export async function runMcpServer(workspace: Workspace): Promise<void> {
  const server = new McpServer({
    name: "kbx",
    version: KBX_VERSION
  }, {
    instructions: KBX_MCP_INSTRUCTIONS
  });

  registerGuidance(server);
  registerMcpTools(server, workspace);

  await server.connect(new StdioServerTransport());
}

export function registerMcpTools(server: McpServer, workspace: Workspace): void {
  server.registerTool(
    "kbx_search",
    {
      description: "Search the user's local kbx knowledge base. Returns previews and chunk IDs; call kbx_get_chunk for full text.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Search query"),
        top_k: z.number().int().min(1).max(50).optional().describe("Number of chunks to return"),
        preview_chars: z.number().int().min(80).max(1200).optional().describe("Maximum preview characters per result"),
        include_text: z.boolean().optional().describe("Include full chunk text in search results. Prefer kbx_get_chunk unless full text is explicitly needed.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ query, top_k, preview_chars, include_text }) => {
      const freshness = await autoRefreshForSearch(workspace);
      const [hits, config] = await Promise.all([searchWorkspace(workspace, query, top_k ?? 5), loadConfig(workspace)]);
      const results = hits.map((hit) => ({
        id: hit.id,
        source: config.mcp.citations === "safe" ? hit.citation_source : hit.source,
        chunk_idx: hit.chunk_idx,
        score: hit.score,
        match: hit.match,
        ...(hit.branch_name ? { branch: hit.branch_name } : {}),
        preview: previewForHit(hit, preview_chars ?? DEFAULT_SEARCH_PREVIEW_CHARS),
        ...(include_text === true ? { text: hit.text } : {})
      }));
      return textResult(JSON.stringify({
        query,
        freshness,
        results,
        next: "Call kbx_get_chunk with a result id when you need the full chunk text."
      }, null, 2));
    }
  );

  server.registerTool(
    "kbx_search_many",
    {
      description: "Run multiple kbx searches in one call. Use for broad discovery without repeated MCP round trips.",
      inputSchema: {
        queries: z.array(z.string().trim().min(1)).min(1).max(10).describe("Search queries"),
        top_k: z.number().int().min(1).max(20).optional().describe("Results per query"),
        preview_chars: z.number().int().min(80).max(1200).optional().describe("Maximum preview characters per result"),
        include_text: z.boolean().optional().describe("Include full chunk text in results. Prefer false unless explicitly needed.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ queries, top_k, preview_chars, include_text }) => {
      const freshness = await autoRefreshForSearch(workspace);
      const config = await loadConfig(workspace);
      const searches = await Promise.all(queries.map(async (query) => {
        const hits = await searchWorkspace(workspace, query, top_k ?? 5);
        return {
          query,
          results: hits.map((hit) => ({
            id: hit.id,
            source: config.mcp.citations === "safe" ? hit.citation_source : hit.source,
            chunk_idx: hit.chunk_idx,
            score: hit.score,
            match: hit.match,
            ...(hit.branch_name ? { branch: hit.branch_name } : {}),
            preview: previewForHit(hit, preview_chars ?? DEFAULT_SEARCH_PREVIEW_CHARS),
            ...(include_text === true ? { text: hit.text } : {})
          }))
        };
      }));
      return textResult(JSON.stringify({
        freshness,
        searches,
        next: "Call kbx_get_chunk for any result you plan to quote or rely on."
      }, null, 2));
    }
  );

  server.registerTool(
    "kbx_context",
    {
      description: "Build a bounded task-context bundle from local kbx search results. Returns grouped full chunks with citations in one call.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Task or topic to build context for"),
        top_k: z.number().int().min(1).max(25).optional().describe("Number of chunks to include"),
        max_chars: z.number().int().min(1000).max(60000).optional().describe("Maximum markdown characters to return")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ query, top_k, max_chars }) => {
      const freshness = await autoRefreshForSearch(workspace);
      const context = await buildWorkspaceContext(workspace, query, {
        topK: top_k ?? 8,
        maxChars: max_chars ?? 16000
      });
      return textResult(`${formatWorkspaceContextMarkdown(context)}\n\n---\nFreshness: ${JSON.stringify(freshness)}`);
    }
  );

  server.registerTool(
    "kbx_search_global",
    {
      description: "Search across all registered local kbx workspaces. Returns workspace-qualified previews and chunk IDs.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Search query"),
        top_k: z.number().int().min(1).max(50).optional().describe("Number of chunks to return"),
        preview_chars: z.number().int().min(80).max(1200).optional().describe("Maximum preview characters per result"),
        include_text: z.boolean().optional().describe("Include full chunk text in search results. Prefer kbx_get_chunk in the owning workspace unless full text is explicitly needed.")
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ query, top_k, preview_chars, include_text }) => {
      const hits = await searchRegisteredWorkspaces(query, top_k ?? 5);
      return textResult(JSON.stringify({
        query,
        results: hits.map((hit) => ({
          id: hit.id,
          workspace: hit.workspace,
          source: hit.citation_source,
          local_source: hit.local_source,
          chunk_idx: hit.chunk_idx,
          score: hit.score,
          match: hit.match,
          preview: previewForHit(hit, preview_chars ?? DEFAULT_SEARCH_PREVIEW_CHARS),
          ...(include_text === true ? { text: hit.text } : {})
        })),
        next: "Use the workspace path and local_source to inspect or refresh the owning workspace."
      }, null, 2));
    }
  );

  server.registerTool(
    "kbx_agent_guide",
    {
      description: "Return kbx agent usage guidance.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => textResult(KBX_AGENT_GUIDE)
  );

  server.registerTool(
    "kbx_list_sources",
    {
      description: "List indexed source roots for the current workspace.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const sources = await loadSources(workspace);
      return textResult(JSON.stringify({ sources }, null, 2));
    }
  );

  server.registerTool(
    "kbx_get_chunk",
    {
      description: "Fetch a specific chunk by id.",
      inputSchema: {
        id: z.string().min(1).describe("Chunk id")
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ id }) => {
      const config = await loadConfig(workspace);
      const lexical = await LexicalIndexStore.open(workspace, { readOnly: true });
      try {
        const chunk = lexical.getChunk(id);
        if (!chunk) {
          return textResult(JSON.stringify({ error: "chunk_not_found", id }, null, 2), true);
        }
        return textResult(JSON.stringify({
          chunk: {
            id: chunk.id,
            text: chunk.text,
            source: config.mcp.citations === "safe" ? chunk.citation_source : chunk.source,
            chunk_idx: chunk.chunk_idx,
            mtime: chunk.mtime
          }
        }, null, 2));
      } finally {
        await lexical.close();
      }
    }
  );

  server.registerTool(
    "kbx_index_status",
    {
      description: "Report workspace index status without refreshing or mutating the index.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const manifest = await loadManifest(workspace);
      const stats = await loadIndexStats(workspace, manifest.model, manifest.dim);
      const doctor = await runDoctor(workspace, {});
      return textResult(JSON.stringify({
        workspace: {
          id: manifest.workspace_id,
          name: manifest.name,
          path: workspace.root
        },
        model: {
          id: manifest.model,
          dim: manifest.dim
        },
        files: Object.keys(stats.files).length,
        last_ingest_at: stats.last_ingest_at || null,
        checks: doctor
      }, null, 2));
    }
  );

  server.registerTool(
    "kbx_watch_status",
    {
      description: "Report freshness and hot-watch guidance for the current workspace. Does not start a long-running watcher.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const freshness = await scanFreshnessForMcp(workspace);
      const config = await loadConfig(workspace);
      return textResult(JSON.stringify({
        watcher: await watchStatus(workspace, config.watch.auto),
        freshness
      }, null, 2));
    }
  );

  server.registerTool(
    "kbx_memory_add",
    {
      description: "Explicitly save a compact, retention-bound session memory note and index it for later kbx search.",
      inputSchema: {
        text: z.string().trim().min(1).max(10000).describe("Compact note, decision, handoff, or event to retain"),
        title: z.string().trim().min(1).max(120).optional().describe("Short title for the retained note"),
        retention_days: z.number().int().min(1).max(3650).describe("Number of days before the note expires")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ text, title, retention_days }) => {
      const { entry, source } = await addSessionMemory(workspace, {
        text,
        title,
        retentionDays: retention_days
      });
      const indexed = await ingestSource(workspace, source);
      return textResult(JSON.stringify({
        memory: entry,
        source,
        indexed,
        next: "Use kbx_search to retrieve this memory later by title, decision text, or related terms."
      }, null, 2));
    }
  );

  server.registerTool(
    "kbx_memory_list",
    {
      description: "List explicit compact session memory notes retained in this workspace.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const [entries, sources] = await Promise.all([
        listSessionMemories(workspace),
        loadSources(workspace)
      ]);
      const source = sessionMemorySource(sources);
      return textResult(JSON.stringify({
        retention_days: source?.retention_days ?? null,
        entries
      }, null, 2));
    }
  );

  server.registerTool(
    "kbx_session_handoff",
    {
      description: "Return a compact workspace handoff for starting or ending an agent session. Does not capture hidden transcripts.",
      inputSchema: {
        source_limit: z.number().int().min(1).max(50).optional().describe("Maximum recent indexed files to include"),
        memory_limit: z.number().int().min(1).max(50).optional().describe("Maximum retained memory notes to include")
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ source_limit, memory_limit }) => {
      return textResult(JSON.stringify(
        await buildSessionHandoff(workspace, {
          sourceLimit: source_limit ?? 10,
          memoryLimit: memory_limit ?? 10
        }),
        null,
        2
      ));
    }
  );

  server.registerTool(
    "kbx_session_list",
    {
      description: "List recent durable kbx session records.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ limit }) => textResult(JSON.stringify({
      sessions: await listSessions(workspace, { limit: limit ?? 20 })
    }, null, 2))
  );

  server.registerTool(
    "kbx_session_show",
    {
      description: "Show one durable kbx session record.",
      inputSchema: {
        session_id: z.string().min(1)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ session_id }) => {
      const session = await getSession(workspace, session_id);
      if (!session) {
        return textResult(JSON.stringify({ error: "session_not_found", session_id }, null, 2), true);
      }
      return textResult(JSON.stringify({ session }, null, 2));
    }
  );

  server.registerTool(
    "kbx_session_events",
    {
      description: "List recorded events for one durable kbx session.",
      inputSchema: {
        session_id: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ session_id, limit }) => textResult(JSON.stringify({
      session_id,
      events: await listSessionEvents(workspace, session_id, { limit: limit ?? 500 })
    }, null, 2))
  );

  server.registerTool(
    "kbx_session_record_event",
    {
      description: "Record one opt-in durable session event. Raw payloads are only stored when sessions.capture=full.",
      inputSchema: {
        session_id: z.string().min(1),
        type: sessionEventTypeSchema,
        summary: z.string().trim().min(1).max(500).optional(),
        tool_name: z.string().trim().min(1).max(120).optional(),
        input: z.unknown().optional(),
        output: z.unknown().optional(),
        error: z.string().max(2000).optional(),
        files: z.array(z.object({
          path: z.string().min(1),
          operation: z.string().min(1).max(40).optional()
        })).max(50).optional(),
        snapshots: z.array(z.object({
          path: z.string().min(1),
          before_text: z.string().nullable().optional(),
          after_text: z.string().nullable().optional()
        })).max(20).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ session_id, type, summary, tool_name, input, output, error, files, snapshots }) => {
      const result = await appendSessionEvent(workspace, {
        sessionId: session_id,
        type,
        summary,
        toolName: tool_name,
        input,
        output,
        error,
        files: files?.map((file) => ({
          path: file.path,
          operation: file.operation ?? "edit"
        })),
        snapshots: snapshots?.map((snapshot) => ({
          path: snapshot.path,
          beforeText: snapshot.before_text ?? null,
          afterText: snapshot.after_text ?? null
        }))
      });
      return textResult(JSON.stringify(result, null, 2));
    }
  );

  server.registerTool(
    "kbx_session_checkpoint",
    {
      description: "Add a named checkpoint to a durable session timeline.",
      inputSchema: {
        session_id: z.string().min(1),
        name: z.string().trim().min(1).max(120),
        note: z.string().trim().max(2000).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ session_id, name, note }) => textResult(JSON.stringify(
      await addSessionCheckpoint(workspace, session_id, name, note),
      null,
      2
    ))
  );

  server.registerTool(
    "kbx_session_replay",
    {
      description: "Return a read-only durable session timeline with events and checkpoints.",
      inputSchema: {
        session_id: z.string().min(1)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ session_id }) => textResult(JSON.stringify({
      session_id,
      timeline: await sessionTimeline(workspace, session_id)
    }, null, 2))
  );

  server.registerTool(
    "kbx_rewind_preview",
    {
      description: "Preview a session rewind from captured file snapshots. Read-only.",
      inputSchema: {
        session_id: z.string().min(1)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ session_id }) => textResult(JSON.stringify(
      await previewSessionRewind(workspace, session_id),
      null,
      2
    ))
  );

  server.registerTool(
    "kbx_rewind_apply",
    {
      description: "Destructive: apply a session rewind from captured file snapshots after config gate and exact preview token.",
      inputSchema: {
        session_id: z.string().min(1),
        confirm: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ session_id, confirm }) => {
      const gate = await requireDestructiveEnabled(workspace, "rewind-session");
      if (gate) return gate;
      try {
        return textResult(JSON.stringify(await applySessionRewind(workspace, session_id, confirm), null, 2));
      } catch (error) {
        return textResult(JSON.stringify({
          error: error instanceof Error && /Invalid confirmation/.test(error.message) ? "invalid_confirmation" : "rewind_failed",
          detail: error instanceof Error ? error.message : String(error)
        }, null, 2), true);
      }
    }
  );

  server.registerTool(
    "kbx_graph_build",
    {
      description: "Rebuild deterministic graph knowledge from indexed chunks.",
      inputSchema: {
        max_chunks: z.number().int().min(1).max(100000).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ max_chunks }) => textResult(JSON.stringify(
      await buildGraph(workspace, { maxChunks: max_chunks }),
      null,
      2
    ))
  );

  server.registerTool(
    "kbx_graph_query",
    {
      description: "Query graph knowledge nodes and immediate relations.",
      inputSchema: {
        query: z.string().trim().min(1),
        limit: z.number().int().min(1).max(100).optional()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ query, limit }) => textResult(JSON.stringify(
      await queryGraph(workspace, query, { limit: limit ?? 20 }),
      null,
      2
    ))
  );

  server.registerTool(
    "kbx_graph_stats",
    {
      description: "Report graph knowledge node and edge counts.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => textResult(JSON.stringify(await graphStats(workspace), null, 2))
  );

  server.registerTool(
    "kbx_refresh_index",
    {
      description: "Refresh all configured sources in the current workspace index. Updates changed files and removes deleted files.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => {
      const result = await refreshWorkspaceIndex(workspace);
      return textResult(JSON.stringify({ refreshed: result }, null, 2));
    }
  );

  server.registerTool(
    "kbx_refresh_file",
    {
      description: "Refresh one workspace file or the covering source that owns it. If the file was deleted, its indexed chunks are removed.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative file path")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ path }) => {
      const result = await refreshWorkspaceFile(workspace, path);
      return textResult(JSON.stringify({ path, refreshed: result }, null, 2));
    }
  );

  server.registerTool(
    "kbx_mcp_config",
    {
      description: "Generate an MCP config snippet for a supported AI client, or list supported clients.",
      inputSchema: {
        client: z.string().optional().describe("Client adapter ID or alias"),
        list: z.boolean().optional().describe("List supported adapters instead of generating one snippet"),
        server_name: z.string().optional().describe("MCP server name to use in generated config"),
        command: z.string().optional().describe("Command to start kbx"),
        args: z.array(z.string()).optional().describe("Arguments to pass to the command")
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ client, list, server_name, command, args }) => {
      if (list === true) {
        return textResult(JSON.stringify({
          adapters: listAdapters().map((adapter) => ({
            id: adapter.id,
            client_name: adapter.clientName,
            config_path: adapter.configPath,
            scope: adapter.scope
          }))
        }, null, 2));
      }
      if (!client) {
        return textResult(JSON.stringify({
          error: "missing_client",
          next: "Call kbx_mcp_config with list=true to see supported clients."
        }, null, 2), true);
      }
      const snippet = generateAdapterConfig(client, {
        serverName: server_name,
        command,
        args
      });
      return textResult(JSON.stringify({ snippet }, null, 2));
    }
  );

  server.registerTool(
    "kbx_remove_source",
    {
      description: "Destructive: remove a source and its indexed chunks. Disabled unless mcp.destructive_tools is enabled.",
      inputSchema: {
        selector: z.string().min(1),
        confirm: z.string().min(1),
        delete_import_snapshot: z.boolean().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ selector, confirm, delete_import_snapshot }) => {
      const gate = await requireDestructiveConfirmation(workspace, "remove-source", confirm);
      if (gate) return gate;
      const result = await removeSource(workspace, selector, { deleteImportSnapshot: delete_import_snapshot === true });
      return textResult(JSON.stringify({ removed: result }, null, 2));
    }
  );

  server.registerTool(
    "kbx_reset_index",
    {
      description: "Destructive: clear the current workspace index while preserving identity and config.",
      inputSchema: {
        confirm: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ confirm }) => {
      const gate = await requireDestructiveConfirmation(workspace, "reset-index", confirm);
      if (gate) return gate;
      await resetWorkspaceIndex(workspace);
      return textResult(JSON.stringify({ reset: true }, null, 2));
    }
  );

  server.registerTool(
    "kbx_forget_workspace",
    {
      description: "Destructive: remove a workspace from the user registry without deleting its .kbx directory.",
      inputSchema: {
        selector: z.string().optional(),
        confirm: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ selector, confirm }) => {
      const gate = await requireDestructiveConfirmation(workspace, "forget-workspace", confirm);
      if (gate) return gate;
      const manifest = await loadManifest(workspace);
      const forgotten = await forgetWorkspace(selector ?? manifest.workspace_id);
      return textResult(JSON.stringify({ forgotten }, null, 2));
    }
  );

  server.registerTool(
    "kbx_delete_workspace_kb",
    {
      description: "Destructive: delete a workspace .kbx directory after explicit gate and confirmation.",
      inputSchema: {
        selector: z.string().optional(),
        confirm: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ selector, confirm }) => {
      const gate = await requireDestructiveConfirmation(workspace, "delete-workspace-kb", confirm);
      if (gate) return gate;
      const manifest = await loadManifest(workspace);
      const deleted = await deleteWorkspaceKnowledgeBase(selector ?? manifest.workspace_id);
      return textResult(JSON.stringify({ deleted }, null, 2));
    }
  );
}

async function buildSessionHandoff(
  workspace: Workspace,
  options: { sourceLimit: number; memoryLimit: number }
) {
  const [manifest, sources, stats, branch, freshness, memories] = await Promise.all([
    loadManifest(workspace),
    loadSources(workspace),
    loadManifest(workspace).then((m) => loadIndexStats(workspace, m.model, m.dim)),
    currentBranchContext(workspace.root),
    scanFreshnessForMcp(workspace),
    listSessionMemories(workspace)
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
    session_memories: memories
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, options.memoryLimit),
    next: [
      "Run kbx_search for task-specific context before editing unfamiliar code.",
      "Call kbx_get_chunk for results you plan to quote or rely on.",
      "Use kbx_memory_add only for compact decisions, preferences, handoffs, or events with explicit retention."
    ]
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

function registerGuidance(server: McpServer): void {
  server.registerPrompt(
    "kbx_usage",
    {
      title: "kbx usage guidance",
      description: "Guidance for agents on when and how to use kbx search and chunk retrieval."
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: KBX_AGENT_GUIDE
          }
        }
      ]
    })
  );

  server.registerResource(
    "kbx_usage",
    "kbx://usage",
    {
      title: "kbx usage guidance",
      description: "Agent instructions for using kbx tools effectively.",
      mimeType: "text/markdown"
    },
    (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: KBX_AGENT_GUIDE
        }
      ]
    })
  );
}

function textResult(text: string, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text
      }
    ],
    isError
  };
}

async function autoRefreshForSearch(workspace: Workspace) {
  try {
    return await refreshWorkspaceFreshness(workspace, {
      maxChanges: MCP_SEARCH_AUTO_REFRESH_MAX_CHANGES
    });
  } catch (error) {
    return {
      refreshed: false,
      error: "freshness_refresh_failed",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function scanFreshnessForMcp(workspace: Workspace) {
  try {
    return await scanWorkspaceFreshness(workspace);
  } catch (error) {
    return {
      error: "freshness_scan_failed",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function requireDestructiveConfirmation(workspace: Workspace, operation: string, confirm: string) {
  const [config, manifest] = await Promise.all([
    loadConfig(workspace),
    loadManifest(workspace)
  ]);
  const required = `${operation}:${manifest.workspace_id}`;
  if (config.mcp.destructive_tools !== "enabled") {
    return textResult(JSON.stringify({
      error: "destructive_tools_disabled",
      operation,
      required_config: "mcp.destructive_tools=enabled"
    }, null, 2), true);
  }
  if (confirm !== required) {
    return textResult(JSON.stringify({
      error: "invalid_confirmation",
      operation,
      required_confirmation: required
    }, null, 2), true);
  }
  return null;
}

async function requireDestructiveEnabled(workspace: Workspace, operation: string) {
  const config = await loadConfig(workspace);
  if (config.mcp.destructive_tools !== "enabled") {
    return textResult(JSON.stringify({
      error: "destructive_tools_disabled",
      operation,
      required_config: "mcp.destructive_tools=enabled"
    }, null, 2), true);
  }
  return null;
}

function excerpt(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 3))}...` : compact;
}

function previewForHit(hit: { text: string; snippet?: string }, maxChars: number): string {
  return excerpt(hit.snippet ?? hit.text, maxChars);
}
