import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KBX_AGENT_GUIDE } from "./agent-guide";
import { runDoctor } from "./doctor";
import { loadIndexStats } from "./indexer";
import { searchWorkspace } from "./search";
import { loadConfig, loadManifest, loadSources, type Workspace } from "./workspace";
import { ChunkVectorStore } from "./vector-store";
import { KBX_VERSION } from "./version";

const DEFAULT_SEARCH_PREVIEW_CHARS = 360;

export async function runMcpServer(workspace: Workspace): Promise<void> {
  const server = new McpServer({
    name: "kbx",
    version: KBX_VERSION
  });

  registerGuidance(server);

  server.registerTool(
    "kbx_search",
    {
      description: "Search the user's local kbx knowledge base. Returns previews and chunk IDs; call kbx_get_chunk for full text.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        top_k: z.number().int().min(1).max(50).optional().describe("Number of chunks to return"),
        preview_chars: z.number().int().min(80).max(1200).optional().describe("Maximum preview characters per result"),
        include_text: z.boolean().optional().describe("Include full chunk text in search results. Prefer kbx_get_chunk unless full text is explicitly needed.")
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ query, top_k, preview_chars, include_text }) => {
      const [hits, config] = await Promise.all([
        searchWorkspace(workspace, query, top_k ?? 5),
        loadConfig(workspace)
      ]);
      const results = hits.map((hit) => ({
        id: hit.id,
        source: config.mcp.citations === "safe" ? hit.citation_source : hit.source,
        chunk_idx: hit.chunk_idx,
        score: hit.score,
        match: hit.match,
        preview: excerpt(hit.text, preview_chars ?? DEFAULT_SEARCH_PREVIEW_CHARS),
        ...(include_text === true ? { text: hit.text } : {})
      }));
      return textResult(JSON.stringify({
        query,
        results,
        next: "Call kbx_get_chunk with a result id when you need the full chunk text."
      }, null, 2));
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

function excerpt(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 3))}...` : compact;
}
