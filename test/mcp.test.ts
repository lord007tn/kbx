import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ingestSource } from "../src/indexer";
import { writeJson } from "../src/io";
import { registerMcpTools } from "../src/mcp";
import { SCHEMA_VERSION, type SourceEntry, type WorkspaceConfig, type WorkspaceManifest } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

const exec = promisify(execFile);

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
    "kbx_delete_workspace_kb",
    "kbx_forget_workspace",
    "kbx_get_chunk",
    "kbx_index_status",
    "kbx_list_sources",
    "kbx_mcp_config",
    "kbx_refresh_file",
    "kbx_refresh_index",
    "kbx_remove_source",
    "kbx_reset_index",
    "kbx_search",
    "kbx_search_global",
    "kbx_search_many",
    "kbx_watch_status"
  ].sort());
  assert.equal(server.toolConfigs.get("kbx_search")?.annotations?.readOnlyHint, false);
  assert.equal(server.toolConfigs.get("kbx_search_many")?.annotations?.readOnlyHint, false);
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
      watcher: { managed_by_mcp: boolean; command: string };
      freshness: { stale: number; deleted: number; newFiles: number };
    };

    assert.equal(body.watcher.managed_by_mcp, false);
    assert.equal(body.watcher.command, "kbx watch");
    assert.deepEqual({ stale: body.freshness.stale, deleted: body.freshness.deleted, newFiles: body.freshness.newFiles }, {
      stale: 0,
      deleted: 0,
      newFiles: 0
    });
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
