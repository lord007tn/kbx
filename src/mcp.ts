import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runDoctor } from "./doctor";
import { loadIndexStats } from "./indexer";
import { searchWorkspace } from "./search";
import { loadConfig, loadManifest, loadSources, type Workspace } from "./workspace";
import { ChunkVectorStore } from "./vector-store";

export async function runMcpServer(workspace: Workspace): Promise<void> {
  const server = new McpServer({
    name: "kbx",
    version: "0.1.0"
  });

  server.registerTool(
    "kbx_search",
    {
      description: "Search the user's personal knowledge base by semantic similarity.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        top_k: z.number().int().min(1).max(50).optional().describe("Number of chunks to return")
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ query, top_k }) => {
      const [hits, config] = await Promise.all([
        searchWorkspace(workspace, query, top_k ?? 5),
        loadConfig(workspace)
      ]);
      const results = hits.map((hit) => ({
        id: hit.id,
        source: config.mcp.citations === "safe" ? hit.citation_source : hit.source,
        chunk_idx: hit.chunk_idx,
        score: hit.score,
        text: hit.text
      }));
      return textResult(JSON.stringify({ results }, null, 2));
    }
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
      const [manifest, config] = await Promise.all([
        loadManifest(workspace),
        loadConfig(workspace)
      ]);
      const store = await ChunkVectorStore.open(workspace, manifest.dim, { readOnly: true });
      try {
        const chunk = store.getChunk(id);
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
        store.close();
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

  await server.connect(new StdioServerTransport());
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
