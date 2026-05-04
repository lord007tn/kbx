import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleClaudeCodePostToolUse, handleFileRefreshHook } from "../src/hooks";
import { ingestSource } from "../src/indexer";
import { writeJson } from "../src/io";
import { searchWorkspace } from "../src/search";
import { SCHEMA_VERSION, type SourceEntry, type WorkspaceManifest } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

test("Claude Code PostToolUse hook refreshes edited workspace files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-hook-refresh-"));
  const previousCwd = process.cwd();
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "note.md"), "# Note\n\nold hook token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    await writeFile(path.join(root, "note.md"), "# Note\n\nnew hook token\n", "utf8");
    process.chdir(root);
    const result = await handleClaudeCodePostToolUse(JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: path.join(root, "note.md")
      }
    }));

    const hits = await searchWorkspace(workspace, "new hook token", 3);
    const serialized = JSON.stringify(result);
    assert.equal(hits[0]?.source, "note.md");
    assert.match(serialized, /refreshed note\.md/);
  } finally {
    process.chdir(previousCwd);
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Code PostToolUse hook skips inputs without file paths", async () => {
  const result = await handleClaudeCodePostToolUse(JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" }
  }));

  assert.match(JSON.stringify(result), /no edited file path/);
});

test("generic file refresh hook accepts JSON paths arrays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-generic-hook-refresh-"));
  const previousCwd = process.cwd();
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "generic.md"), "# Note\n\nold generic token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    await writeFile(path.join(root, "generic.md"), "# Note\n\nnew generic token\n", "utf8");
    process.chdir(root);
    const result = await handleFileRefreshHook(JSON.stringify({
      paths: ["generic.md"]
    }));

    const hits = await searchWorkspace(workspace, "new generic token", 3);
    assert.equal(hits[0]?.source, "generic.md");
    assert.match(JSON.stringify(result), /generic edit/);
  } finally {
    process.chdir(previousCwd);
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("generic file refresh hook accepts paths whose segment starts with two dots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-generic-hook-dotdot-refresh-"));
  const previousCwd = process.cwd();
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    const source: SourceEntry = { path: "..notes", kind: "workspace", include: [], exclude: [] };
    await mkdir(path.join(root, "..notes"), { recursive: true });
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "..notes", "note.md"), "# Note\n\nold dotdot token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    await writeFile(path.join(root, "..notes", "note.md"), "# Note\n\nnew dotdot token\n", "utf8");
    process.chdir(root);
    const result = await handleFileRefreshHook(JSON.stringify({
      paths: ["..notes/note.md"]
    }));

    const hits = await searchWorkspace(workspace, "new dotdot token", 3);
    assert.equal(hits[0]?.source, "..notes/note.md");
    assert.match(JSON.stringify(result), /refreshed \.\.notes\/note\.md/);
  } finally {
    process.chdir(previousCwd);
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

function manifest(modelName: string, dim: number): WorkspaceManifest {
  return {
    workspace_id: "test-workspace",
    name: "test",
    model: modelName,
    dim,
    schema_version: SCHEMA_VERSION,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z"
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
