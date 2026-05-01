import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../src/doctor";
import { ingestSource } from "../src/indexer";
import { writeJson } from "../src/io";
import { LexicalIndexStore } from "../src/lexical-index";
import { SCHEMA_VERSION, type SourceEntry, type WorkspaceManifest } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

test("runDoctor reports a healthy lexical index when it matches the vector collection", async () => {
  const fixture = await createIndexedWorkspace("kbx-doctor-lexical-ok-");
  try {
    const lines = await runDoctor(fixture.workspace, {});
    const lexical = lines.find((line) => line.label === "lexical");
    const adapters = lines.find((line) => line.label === "mcp-adapters");
    const hooks = lines.find((line) => line.label === "hook-adapters");

    assert.equal(lexical?.ok, true);
    assert.match(lexical?.detail ?? "", /matches collection/);
    assert.equal(adapters?.ok, true);
    assert.match(adapters?.detail ?? "", /config template\(s\) valid/);
    assert.equal(hooks?.ok, true);
    assert.match(hooks?.detail ?? "", /claude-code/);
  } finally {
    await fixture.cleanup();
  }
});

test("runDoctor flags lexical and vector collection drift", async () => {
  const fixture = await createIndexedWorkspace("kbx-doctor-lexical-drift-");
  try {
    const lexical = await LexicalIndexStore.open(fixture.workspace);
    lexical.deleteSource("note.md");
    await lexical.close();

    const lines = await runDoctor(fixture.workspace, {});
    const lexicalLine = lines.find((line) => line.label === "lexical");

    assert.equal(lexicalLine?.ok, false);
    assert.match(lexicalLine?.detail ?? "", /collection has/);
    assert.match(lexicalLine?.detail ?? "", /repair hybrid retrieval/);
  } finally {
    await fixture.cleanup();
  }
});

async function createIndexedWorkspace(prefix: string) {
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = workspaceFromRoot(root);
  const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };

  await mkdir(workspace.kbxDir, { recursive: true });
  await writeFile(path.join(root, "note.md"), "# Note\n\nlexical doctor token\n", "utf8");
  await writeJson(workspace.manifestPath, manifest("test-model", 3));
  await writeJson(workspace.configPath, defaultConfig);
  await writeJson(workspace.sourcesPath, [source]);
  await ingestSource(workspace, source);

  return {
    root,
    workspace,
    cleanup: async () => {
      restoreEnv("KBX_EMBEDDER", previousEmbedder);
      await rm(root, { recursive: true, force: true });
    }
  };
}

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
