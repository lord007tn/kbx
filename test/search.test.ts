import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestSource } from "../src/indexer";
import { writeJson } from "../src/io";
import { searchWorkspace } from "../src/search";
import { SCHEMA_VERSION, type SourceEntry, type WorkspaceManifest } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

test("searchWorkspace includes lexical matches for exact symbols", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-search-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "api.ts"), "export const SDM_CLICKHOUSE_TIMEOUT_MS = 8000;\n", "utf8");
    await writeFile(path.join(root, "notes.md"), "# Notes\n\nunrelated content\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    const hits = await searchWorkspace(workspace, "SDM_CLICKHOUSE_TIMEOUT_MS", 3);

    assert.equal(hits[0]?.source, "api.ts");
    assert.match(hits[0]?.text ?? "", /SDM_CLICKHOUSE_TIMEOUT_MS/);
    assert.match(hits[0]?.match ?? "", /lexical|hybrid/);
  } finally {
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
