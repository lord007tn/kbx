import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestSource, loadIndexStats } from "../src/indexer";
import { writeJson } from "../src/io";
import { searchWorkspace } from "../src/search";
import { addSessionMemory, listSessionMemories, pruneExpiredSessionMemories, sessionMemorySource } from "../src/session-memory";
import { SCHEMA_VERSION, type WorkspaceManifest } from "../src/types";
import { defaultConfig, loadSources, workspaceFromRoot } from "../src/workspace";

test("addSessionMemory records a retention-bound source and indexes searchable notes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-memory-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    await writeJson(workspace.sourcesPath, []);

    const { entry, source } = await addSessionMemory(workspace, {
      title: "SQLite decision",
      text: "Decision: keep SQLite FTS5 as the lexical baseline for v0.4.",
      retentionDays: 7
    });
    await ingestSource(workspace, source);

    const sources = await loadSources(workspace);
    assert.equal(sessionMemorySource(sources)?.retention_days, 7);
    assert.equal((await listSessionMemories(workspace))[0]?.id, entry.id);

    const hits = await searchWorkspace(workspace, "SQLite lexical baseline", 3);
    assert.equal(hits[0]?.source.startsWith("session-memory:"), true);
    assert.match(hits[0]?.text ?? "", /SQLite FTS5/);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("pruneExpiredSessionMemories deletes expired notes and refresh removes indexed chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-memory-prune-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    await writeJson(workspace.sourcesPath, []);

    const { source } = await addSessionMemory(workspace, {
      text: "temporary prune token",
      retentionDays: 1
    });
    await ingestSource(workspace, source);

    const expired = await pruneExpiredSessionMemories(workspace, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
    assert.equal(expired.length, 1);
    await ingestSource(workspace, source);

    const hits = await searchWorkspace(workspace, "temporary prune token", 3);
    const stats = await loadIndexStats(workspace, "test-model", 3);
    assert.equal(hits.some((hit) => hit.text.includes("temporary prune token")), false);
    assert.equal(Object.keys(stats.files).some((file) => file.startsWith(".kbx/sessions/")), false);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("addSessionMemory requires explicit positive retention", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-memory-retention-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await assert.rejects(
      () => addSessionMemory(workspace, { text: "no retention", retentionDays: 0 }),
      /positive number of days/
    );
  } finally {
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
