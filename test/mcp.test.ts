import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ingestSource } from "../src/indexer";
import { writeJson } from "../src/io";
import { registerMcpTools } from "../src/mcp";
import { SCHEMA_VERSION, type SourceEntry, type WorkspaceConfig, type WorkspaceManifest } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

const exec = promisify(execFile);
const cliPath = path.resolve("src", "cli.ts");
const tsxLoaderUrl = pathToFileURL(path.resolve("node_modules", "tsx", "dist", "loader.mjs")).href;

type ToolHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;

class FakeMcpServer {
  tools = new Map<string, ToolHandler>();
  toolConfigs = new Map<string, { annotations?: Record<string, unknown> }>();

  registerTool(name: string, config: { annotations?: Record<string, unknown> }, handler: ToolHandler): void {
    this.toolConfigs.set(name, config);
    this.tools.set(name, handler);
  }
}

test("registerMcpTools exposes read, maintenance, and gated destructive tools", () => {
  const server = new FakeMcpServer();
  const workspace = workspaceFromRoot("D:/tmp/kbx-test");

  registerMcpTools(server as unknown as McpServer, workspace);

  assert.deepEqual([...server.tools.keys()].sort(), [
    "kbx_agent_guide",
    "kbx_context",
    "kbx_delete_workspace_kb",
    "kbx_dev_report_add",
    "kbx_dev_report_list",
    "kbx_file_context",
    "kbx_forget_workspace",
    "kbx_get_chunk",
    "kbx_graph_build",
    "kbx_graph_query",
    "kbx_graph_stats",
    "kbx_index_status",
    "kbx_inspect",
    "kbx_list_sources",
    "kbx_memory_add",
    "kbx_memory_history",
    "kbx_memory_list",
    "kbx_memory_verify",
    "kbx_mcp_config",
    "kbx_refresh_file",
    "kbx_refresh_index",
    "kbx_remove_source",
    "kbx_rewind_apply",
    "kbx_rewind_preview",
    "kbx_reset_index",
    "kbx_search",
    "kbx_search_global",
    "kbx_search_many",
    "kbx_session_checkpoint",
    "kbx_session_events",
    "kbx_session_handoff",
    "kbx_session_list",
    "kbx_session_record_event",
    "kbx_session_replay",
    "kbx_session_search",
    "kbx_session_show",
    "kbx_watch_status"
  ].sort());
  assert.equal(server.toolConfigs.get("kbx_search")?.annotations?.readOnlyHint, false);
  assert.equal(server.toolConfigs.get("kbx_search_many")?.annotations?.readOnlyHint, false);
});

test("kbx mcp stdio supports search and reports validation errors", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-stdio-");
  const client = new Client({ name: "kbx-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsxLoaderUrl, cliPath, "mcp"],
    cwd: fixture.root,
    env: childEnv({
      KBX_EMBEDDER: "hash",
      KBX_HOME: path.join(fixture.root, ".home"),
      KBX_MODEL_CACHE: path.join(fixture.root, ".models")
    })
  });
  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const searchResponse = await client.callTool({
      name: "kbx_search",
      arguments: {
        query: "alpha token",
        top_k: 1
      }
    });
    const body = JSON.parse(toolText(searchResponse)) as {
      results: Array<{ source: string }>;
    };
    const blankResponse = await client.callTool({
      name: "kbx_search",
      arguments: {
        query: "   "
      }
    });

    assert.equal(tools.tools.some((tool) => tool.name === "kbx_search"), true);
    assert.match(client.getInstructions() ?? "", /kbx_context/);
    assert.equal(body.results[0]?.source, "alpha.md");
    assert.equal(blankResponse.isError, true);
    assert.match(toolText(blankResponse), /Input validation error|too_small/);
  } finally {
    await client.close();
    await fixture.cleanup();
  }
});

test("kbx mcp stdio starts outside initialized workspaces with bootstrap tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-mcp-bootstrap-"));
  const client = new Client({ name: "kbx-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsxLoaderUrl, cliPath, "mcp"],
    cwd: root,
    env: childEnv({
      KBX_EMBEDDER: "hash",
      KBX_HOME: path.join(root, ".home"),
      KBX_MODEL_CACHE: path.join(root, ".models")
    })
  });
  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const statusResponse = await client.callTool({
      name: "kbx_index_status",
      arguments: {}
    });
    const searchResponse = await client.callTool({
      name: "kbx_search",
      arguments: {
        query: "anything"
      }
    });
    const configResponse = await client.callTool({
      name: "kbx_mcp_config",
      arguments: {
        client: "codex"
      }
    });
    const status = JSON.parse(toolText(statusResponse)) as { initialized: boolean; error: string; cwd: string };
    const config = JSON.parse(toolText(configResponse)) as { snippet: { content: string } };

    assert.equal(tools.tools.some((tool) => tool.name === "kbx_search"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "kbx_search_global"), true);
    assert.equal(status.initialized, false);
    assert.equal(status.error, "workspace_not_initialized");
    assert.equal(status.cwd, root);
    assert.equal(searchResponse.isError, true);
    assert.match(toolText(searchResponse), /workspace_not_initialized/);
    assert.match(config.snippet.content, /\[mcp_servers\.kbx\]/);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("kbx_search_many returns separate result groups", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-search-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const response = await callTool(server, "kbx_search_many", {
      queries: ["alpha token", "beta token"],
      top_k: 2
    });
    const body = JSON.parse(response.content[0]!.text) as { searches: Array<{ query: string; results: unknown[] }> };

    assert.equal(body.searches.length, 2);
    assert.equal(body.searches[0]?.query, "alpha token");
    assert.ok((body.searches[0]?.results.length ?? 0) > 0);
    assert.ok((body.searches[1]?.results.length ?? 0) > 0);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_get_chunk fetches the alias id returned by search", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-get-chunk-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const searchResponse = await callTool(server, "kbx_search", {
      query: "alpha token",
      top_k: 1
    });
    const searchBody = JSON.parse(searchResponse.content[0]!.text) as { results: Array<{ id: string }> };
    const response = await callTool(server, "kbx_get_chunk", { id: searchBody.results[0]!.id });
    const body = JSON.parse(response.content[0]!.text) as { chunk: { source: string; text: string } };

    assert.equal(body.chunk.source, "alpha.md");
    assert.match(body.chunk.text, /alpha token/);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_search expands returned IDs without requiring a new query", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-expand-search-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const searchResponse = await callTool(server, "kbx_search", {
      query: "alpha token",
      top_k: 1
    });
    const searchBody = JSON.parse(searchResponse.content[0]!.text) as { mode: string; results: Array<{ id: string }> };
    const expandResponse = await callTool(server, "kbx_search", {
      expand_ids: [searchBody.results[0]!.id]
    });
    const expandBody = JSON.parse(expandResponse.content[0]!.text) as {
      mode: string;
      results: Array<{ source: string; text: string }>;
      missing_ids: string[];
    };

    assert.equal(searchBody.mode, "compact");
    assert.equal(expandBody.mode, "expanded");
    assert.equal(expandBody.results[0]?.source, "alpha.md");
    assert.match(expandBody.results[0]?.text ?? "", /alpha token/);
    assert.deepEqual(expandBody.missing_ids, []);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_search includes branch metadata for Git-scoped results", async () => {
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-mcp-branch-"));
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "kbx@example.test"]);
    await git(root, ["config", "user.name", "kbx tests"]);
    const workspace = workspaceFromRoot(root);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "branch.md"), "# Branch\n\nmcp branch metadata token\n", "utf8");
    await git(root, ["add", "branch.md"]);
    await git(root, ["commit", "-m", "branch metadata"]);
    await writeJson(workspace.manifestPath, testManifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, workspace);
    const response = await callTool(server, "kbx_search", {
      query: "mcp branch metadata token",
      top_k: 1
    });
    const body = JSON.parse(response.content[0]!.text) as { results: Array<{ branch?: string; source: string }> };

    assert.equal(body.results[0]?.source, "branch.md");
    assert.equal(body.results[0]?.branch, "main");
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});


test("kbx_refresh_file updates indexed search content", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-refresh-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);
    await writeFile(path.join(fixture.root, "alpha.md"), "# Alpha\n\nfresh mcp token\n", "utf8");

    await callTool(server, "kbx_refresh_file", { path: "alpha.md" });
    const response = await callTool(server, "kbx_search", { query: "fresh mcp token", top_k: 3 });
    const body = JSON.parse(response.content[0]!.text) as { results: Array<{ source: string; preview: string }> };

    assert.equal(body.results[0]?.source, "alpha.md");
    assert.match(body.results[0]?.preview ?? "", /fresh mcp token/);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_search opportunistically refreshes changed indexed files", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-auto-refresh-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);
    await waitForMtimeTick();
    await writeFile(path.join(fixture.root, "alpha.md"), "# Alpha\n\nauto refreshed mcp token\n", "utf8");

    const response = await callTool(server, "kbx_search", { query: "auto refreshed mcp token", top_k: 3 });
    const body = JSON.parse(response.content[0]!.text) as {
      freshness: { refreshed: boolean };
      results: Array<{ source: string; preview: string }>;
    };

    assert.equal(body.freshness.refreshed, true);
    assert.equal(body.results[0]?.source, "alpha.md");
    assert.match(body.results[0]?.preview ?? "", /auto refreshed mcp token/);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_mcp_config lists adapters and generates snippets", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-config-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const listResponse = await callTool(server, "kbx_mcp_config", { list: true });
    const listBody = JSON.parse(listResponse.content[0]!.text) as { adapters: Array<{ id: string }> };
    assert.ok(listBody.adapters.some((adapter) => adapter.id === "codex"));

    const snippetResponse = await callTool(server, "kbx_mcp_config", { client: "codex" });
    const snippetBody = JSON.parse(snippetResponse.content[0]!.text) as { snippet: { content: string } };
    assert.match(snippetBody.snippet.content, /\[mcp_servers\.kbx\]/);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_watch_status reports freshness and CLI watcher guidance", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-watch-status-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const response = await callTool(server, "kbx_watch_status", {});
    const body = JSON.parse(response.content[0]!.text) as {
      watcher: { auto: string; running: boolean; pid: number | null; pid_file: string; log_file: string };
      freshness: { stale: number; deleted: number; newFiles: number };
    };

    assert.equal(body.watcher.auto, "disabled");
    assert.equal(body.watcher.running, false);
    assert.equal(body.watcher.pid, null);
    assert.match(body.watcher.pid_file, /watch\.pid$/);
    assert.match(body.watcher.log_file, /watch\.log$/);
    assert.deepEqual({ stale: body.freshness.stale, deleted: body.freshness.deleted, newFiles: body.freshness.newFiles }, {
      stale: 0,
      deleted: 0,
      newFiles: 0
    });
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_dev_report_add respects opt-in config", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-dev-report-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const skippedResponse = await callTool(server, "kbx_dev_report_add", {
      task: "test task",
      summary: "should not persist while disabled"
    });
    const skipped = JSON.parse(skippedResponse.content[0]!.text) as { report: { skipped?: boolean; reason?: string } };
    assert.equal(skipped.report.skipped, true);
    assert.equal(skipped.report.reason, "dev_report_disabled");

    await writeJson(fixture.workspace.configPath, {
      ...defaultConfig,
      dev: {
        ...defaultConfig.dev,
        report: "enabled"
      }
    });
    const savedResponse = await callTool(server, "kbx_dev_report_add", {
      task: "test task",
      summary: "saved report",
      issues: ["one issue"],
      findings: ["one finding"],
      good: ["one good point"]
    });
    const saved = JSON.parse(savedResponse.content[0]!.text) as { report: { relative_path: string; skipped?: boolean } };
    assert.equal(saved.report.skipped, undefined);
    assert.match(saved.report.relative_path, /^\.kbx\/debug\/reports\/.+\.md$/);

    const listResponse = await callTool(server, "kbx_dev_report_list", {});
    const listed = JSON.parse(listResponse.content[0]!.text) as { reports: Array<{ preview: string }> };
    assert.equal(listed.reports.length, 1);
    assert.match(listed.reports[0]!.preview, /saved report/);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_agent_guide explains freshness and destructive gates", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-agent-guide-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const response = await callTool(server, "kbx_agent_guide", {});
    const text = response.content[0]!.text;

    assert.match(text, /kbx_watch_status/);
    assert.match(text, /kbx_refresh_file/);
    assert.match(text, /mcp\.destructive_tools=enabled/);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_context returns grouped task context", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-context-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const response = await callTool(server, "kbx_context", {
      query: "alpha token",
      top_k: 1,
      max_chars: 4000
    });
    const text = response.content[0]!.text;

    assert.match(text, /# kbx context/);
    assert.match(text, /## alpha\.md/);
    assert.match(text, /alpha token/);
    assert.match(text, /Freshness:/);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_memory_add saves explicit retained notes for later search", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-memory-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const addResponse = await callTool(server, "kbx_memory_add", {
      title: "MCP retained decision",
      text: "Decision: retain explicit MCP memory notes with a retention policy.",
      type: "decision",
      files: ["src/mcp.ts"],
      tags: ["mcp", "memory"],
      source_chunk_ids: ["chunk_support"],
      retention_days: 14
    });
    const addBody = JSON.parse(addResponse.content[0]!.text) as {
      memory: { id: string; title: string; type: string; files: string[]; tags: string[]; source_chunk_ids: string[]; retention: { tier: string; score: number }; expires_at: string };
      indexed: { chunks: number };
    };
    const listResponse = await callTool(server, "kbx_memory_list", {});
    const listBody = JSON.parse(listResponse.content[0]!.text) as {
      retention_days: number;
      entries: Array<{ id: string; title: string }>;
    };
    const searchResponse = await callTool(server, "kbx_search", {
      query: "explicit MCP memory retention policy",
      top_k: 3
    });
    const searchBody = JSON.parse(searchResponse.content[0]!.text) as {
      results: Array<{ source: string; preview: string }>;
    };

    assert.equal(addBody.memory.title, "MCP retained decision");
    assert.equal(addBody.memory.type, "decision");
    assert.deepEqual(addBody.memory.files, ["src/mcp.ts"]);
    assert.deepEqual(addBody.memory.tags, ["mcp", "memory"]);
    assert.deepEqual(addBody.memory.source_chunk_ids, ["chunk_support"]);
    assert.equal(addBody.memory.retention.tier, "hot");
    assert.ok(addBody.indexed.chunks > 0);
    assert.equal(listBody.retention_days, 14);
    assert.equal(listBody.entries.some((entry) => entry.id === addBody.memory.id), true);
    assert.equal(searchBody.results.some((hit) => hit.source.startsWith("session-memory:")), true);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_memory_verify checks retained note source chunk citations", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-memory-verify-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);
    const searchResponse = await callTool(server, "kbx_search", {
      query: "alpha token",
      top_k: 1
    });
    const searchBody = JSON.parse(searchResponse.content[0]!.text) as { results: Array<{ id: string }> };
    const supportId = searchBody.results[0]!.id;
    const addResponse = await callTool(server, "kbx_memory_add", {
      title: "Verified memory",
      text: "Decision: alpha token support should remain traceable.",
      type: "decision",
      source_chunk_ids: [supportId],
      retention_days: 14
    });
    const addBody = JSON.parse(addResponse.content[0]!.text) as { memory: { id: string } };

    const verifyResponse = await callTool(server, "kbx_memory_verify", {
      id: addBody.memory.id.slice(0, 8)
    });
    const verifyBody = JSON.parse(verifyResponse.content[0]!.text) as {
      status: string;
      citations: Array<{ id: string; source: string; preview: string }>;
      missing_source_chunk_ids: string[];
    };

    assert.equal(verifyBody.status, "verified");
    assert.equal(verifyBody.citations[0]?.id, supportId);
    assert.equal(verifyBody.citations[0]?.source, "alpha.md");
    assert.match(verifyBody.citations[0]?.preview ?? "", /alpha token/);
    assert.deepEqual(verifyBody.missing_source_chunk_ids, []);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_memory_history returns retained note supersession chain", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-memory-history-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);
    const firstResponse = await callTool(server, "kbx_memory_add", {
      title: "Old memory",
      text: "Decision: old memory history token.",
      type: "decision",
      retention_days: 30
    });
    const firstBody = JSON.parse(firstResponse.content[0]!.text) as { memory: { id: string } };
    const secondResponse = await callTool(server, "kbx_memory_add", {
      title: "New memory",
      text: "Decision: new memory history token.",
      type: "decision",
      supersedes: [firstBody.memory.id],
      retention_days: 30
    });
    const secondBody = JSON.parse(secondResponse.content[0]!.text) as { memory: { id: string } };

    const historyResponse = await callTool(server, "kbx_memory_history", {
      id: secondBody.memory.id.slice(0, 8)
    });
    const historyBody = JSON.parse(historyResponse.content[0]!.text) as {
      summary: { chain_length: number; ancestors: number; descendants: number; latest: number; superseded: number };
      chain: Array<{ id: string; title: string; is_latest: boolean; superseded_by?: string }>;
      latest: Array<{ id: string }>;
    };

    assert.equal(historyBody.summary.chain_length, 2);
    assert.equal(historyBody.summary.ancestors, 1);
    assert.equal(historyBody.summary.descendants, 0);
    assert.equal(historyBody.summary.latest, 1);
    assert.equal(historyBody.summary.superseded, 1);
    assert.deepEqual(historyBody.chain.map((entry) => entry.title), ["Old memory", "New memory"]);
    assert.equal(historyBody.chain[0]?.superseded_by, secondBody.memory.id);
    assert.equal(historyBody.latest[0]?.id, secondBody.memory.id);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_file_context returns search hits and retained memories linked to files", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-file-context-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);
    const oldResponse = await callTool(server, "kbx_memory_add", {
      title: "Old file lesson",
      text: "Bug lesson: alpha file used to need old review handling.",
      type: "bug",
      files: ["alpha.md"],
      retention_days: 30
    });
    const oldBody = JSON.parse(oldResponse.content[0]!.text) as { memory: { id: string } };
    await callTool(server, "kbx_memory_add", {
      title: "File lesson",
      text: "Bug lesson: alpha file needs careful review before edits.",
      type: "bug",
      files: ["alpha.md"],
      supersedes: [oldBody.memory.id],
      retention_days: 30
    });

    const response = await callTool(server, "kbx_file_context", {
      files: ["alpha.md"],
      terms: ["review"],
      top_k: 3
    });
    const body = JSON.parse(response.content[0]!.text) as {
      linked_memories: Array<{ title: string; type: string; files: string[] }>;
      search_results: Array<{ source: string; preview: string }>;
    };

    assert.equal(body.linked_memories.some((memory) => memory.title === "File lesson" && memory.type === "bug"), true);
    assert.equal(body.linked_memories.some((memory) => memory.title === "Old file lesson"), false);
    assert.equal(body.search_results.some((hit) => hit.source === "alpha.md"), true);

    const historyResponse = await callTool(server, "kbx_file_context", {
      files: ["alpha.md"],
      include_superseded_memories: true
    });
    const historyBody = JSON.parse(historyResponse.content[0]!.text) as {
      linked_memories: Array<{ title: string }>;
    };
    assert.equal(historyBody.linked_memories.some((memory) => memory.title === "Old file lesson"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_inspect returns read-only workspace and memory summary", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-inspect-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);
    await callTool(server, "kbx_memory_add", {
      title: "Inspect memory",
      text: "Decision: inspection should show retained memory counts.",
      type: "decision",
      retention_days: 14
    });

    const response = await callTool(server, "kbx_inspect", {
      source_limit: 2,
      memory_limit: 2
    });
    const body = JSON.parse(response.content[0]!.text) as {
      workspace: { id: string };
      index: { files: number; chunks: number };
      memories: { total: number; latest: number; by_type: Record<string, number> };
    };

    assert.equal(body.workspace.id, fixture.manifest.workspace_id);
    assert.ok(body.index.files >= 2);
    assert.ok(body.index.chunks >= 2);
    assert.ok(body.memories.total >= 1);
    assert.equal(body.memories.by_type.decision, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx_session_handoff summarizes workspace state without hidden transcripts", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-handoff-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);
    await callTool(server, "kbx_memory_add", {
      title: "Handoff note",
      text: "Handoff: the next agent should search before editing unfamiliar code.",
      retention_days: 7
    });

    const response = await callTool(server, "kbx_session_handoff", {
      source_limit: 1,
      memory_limit: 2
    });
    const body = JSON.parse(response.content[0]!.text) as {
      workspace: { id: string; name: string };
      index: { files: number; chunks: number; freshness: { stale: number; deleted: number; newFiles: number } };
      recent_sources: Array<{ source: string }>;
      session_memories: Array<{ title: string }>;
      next: string[];
    };

    assert.equal(body.workspace.id, "test-workspace");
    assert.equal(body.workspace.name, "test");
    assert.ok(body.index.files >= 2);
    assert.ok(body.index.chunks >= 2);
    assert.equal(body.index.freshness.stale, 0);
    assert.equal(body.recent_sources.length, 1);
    assert.equal(body.session_memories.some((entry) => entry.title === "Handoff note"), true);
    assert.match(body.next.join(" "), /kbx_memory_add/);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx session MCP tools record, list, and replay events", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-session-tools-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const recordResponse = await callTool(server, "kbx_session_record_event", {
      session_id: "session-tools",
      type: "note",
      summary: "Reviewed durable sessions"
    });
    const checkpointResponse = await callTool(server, "kbx_session_checkpoint", {
      session_id: "session-tools",
      name: "ready"
    });
    const listResponse = await callTool(server, "kbx_session_list", {});
    const eventsResponse = await callTool(server, "kbx_session_events", { session_id: "session-tools" });
    const searchResponse = await callTool(server, "kbx_session_search", { query: "durable sessions" });
    const replayResponse = await callTool(server, "kbx_session_replay", { session_id: "session-tools" });
    const recordBody = JSON.parse(recordResponse.content[0]!.text) as { captured: boolean; event: { summary: string } };
    const checkpointBody = JSON.parse(checkpointResponse.content[0]!.text) as { checkpoint: { name: string } };
    const listBody = JSON.parse(listResponse.content[0]!.text) as { sessions: Array<{ id: string }> };
    const eventsBody = JSON.parse(eventsResponse.content[0]!.text) as { events: Array<{ summary: string }> };
    const searchBody = JSON.parse(searchResponse.content[0]!.text) as { results: Array<{ session: { id: string } }> };
    const replayBody = JSON.parse(replayResponse.content[0]!.text) as { timeline: unknown[] };

    assert.equal(recordBody.captured, true);
    assert.equal(recordBody.event.summary, "Reviewed durable sessions");
    assert.equal(checkpointBody.checkpoint.name, "ready");
    assert.equal(listBody.sessions.some((session) => session.id === "session-tools"), true);
    assert.equal(eventsBody.events.length, 2);
    assert.equal(searchBody.results.some((hit) => hit.session.id === "session-tools"), true);
    assert.ok(replayBody.timeline.length >= 2);
  } finally {
    await fixture.cleanup();
  }
});

test("kbx graph MCP tools build and query graph knowledge", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-graph-tools-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const buildResponse = await callTool(server, "kbx_graph_build", {});
    const queryResponse = await callTool(server, "kbx_graph_query", { query: "Alpha" });
    const statsResponse = await callTool(server, "kbx_graph_stats", {});
    const buildBody = JSON.parse(buildResponse.content[0]!.text) as { chunks_scanned: number; nodes: number };
    const queryBody = JSON.parse(queryResponse.content[0]!.text) as { nodes: Array<{ label: string; edges: unknown[] }> };
    const statsBody = JSON.parse(statsResponse.content[0]!.text) as { nodes: number };

    assert.ok(buildBody.chunks_scanned >= 2);
    assert.ok(buildBody.nodes >= 2);
    assert.equal(queryBody.nodes.some((node) => /Alpha|alpha\.md/.test(node.label)), true);
    assert.equal(statsBody.nodes, buildBody.nodes);
  } finally {
    await fixture.cleanup();
  }
});

test("destructive MCP tools require config gate and confirmation token", async () => {
  const fixture = await createIndexedWorkspace("kbx-mcp-gate-");
  try {
    const server = new FakeMcpServer();
    registerMcpTools(server as unknown as McpServer, fixture.workspace);

    const disabled = await callTool(server, "kbx_reset_index", { confirm: `reset-index:${fixture.manifest.workspace_id}` });
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0]!.text, /destructive_tools_disabled/);

    await writeJson(fixture.workspace.configPath, {
      ...defaultConfig,
      mcp: {
        ...defaultConfig.mcp,
        destructive_tools: "enabled"
      }
    } satisfies WorkspaceConfig);

    const invalid = await callTool(server, "kbx_reset_index", { confirm: "yes" });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0]!.text, /invalid_confirmation/);

    await writeFile(path.join(fixture.root, "rewind.md"), "after\n", "utf8");
    await callTool(server, "kbx_session_record_event", {
      session_id: "rewind-session",
      type: "file_edit",
      summary: "changed rewind file",
      files: [{ path: "rewind.md", operation: "edit" }],
      snapshots: [{ path: "rewind.md", before_text: "before\n", after_text: "after\n" }]
    });
    const previewResponse = await callTool(server, "kbx_rewind_preview", { session_id: "rewind-session" });
    const previewBody = JSON.parse(previewResponse.content[0]!.text) as { confirmation: string };
    const rewindResponse = await callTool(server, "kbx_rewind_apply", {
      session_id: "rewind-session",
      confirm: previewBody.confirmation
    });
    assert.equal(rewindResponse.isError, false);
    assert.equal(await readFile(path.join(fixture.root, "rewind.md"), "utf8"), "before\n");

    const reset = await callTool(server, "kbx_reset_index", { confirm: `reset-index:${fixture.manifest.workspace_id}` });
    assert.equal(reset.isError, false);
    await assert.rejects(() => access(fixture.workspace.lexicalPath), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

async function callTool(server: FakeMcpServer, name: string, input: Record<string, unknown>) {
  const handler = server.tools.get(name);
  assert.ok(handler, `Missing registered tool ${name}`);
  return handler(input);
}

async function createIndexedWorkspace(prefix: string) {
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = workspaceFromRoot(root);
  const manifest = testManifest("test-model", 3);
  const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };

  await mkdir(workspace.kbxDir, { recursive: true });
  await writeFile(path.join(root, "alpha.md"), "# Alpha\n\nalpha token\n", "utf8");
  await writeFile(path.join(root, "beta.md"), "# Beta\n\nbeta token\n", "utf8");
  await writeJson(workspace.manifestPath, manifest);
  await writeJson(workspace.configPath, defaultConfig);
  await writeJson(workspace.sourcesPath, [source]);
  await ingestSource(workspace, source);

  return {
    root,
    workspace,
    manifest,
    cleanup: async () => {
      restoreEnv("KBX_EMBEDDER", previousEmbedder);
      await rm(root, { recursive: true, force: true });
    }
  };
}

function testManifest(modelName: string, dim: number): WorkspaceManifest {
  return {
    workspace_id: "test-workspace",
    name: "test",
    model: modelName,
    dim,
    schema_version: SCHEMA_VERSION,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z"
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", ["-C", cwd, ...args], { windowsHide: true });
}

async function waitForMtimeTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return {
    ...env,
    ...extra
  };
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  return first?.type === "text" ? first.text ?? "" : "";
}
