import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestSource, loadIndexStats, rebuildWorkspaceIndexForModel, removeSource } from "../src/indexer";
import { writeJson } from "../src/io";
import { SCHEMA_VERSION, type SourceEntry, type WorkspaceManifest } from "../src/types";
import { defaultConfig, loadManifest, workspaceFromRoot } from "../src/workspace";

test("rebuildWorkspaceIndexForModel swaps in a rebuilt index after success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-rebuild-success-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "note.md"), "# Alpha\n\nalpha beta gamma\n", "utf8");
    const oldManifest = manifest("old-model", 3);
    await writeJson(workspace.manifestPath, oldManifest);
    await writeJson(workspace.configPath, defaultConfig);
    const sources: SourceEntry[] = [{ path: ".", kind: "workspace", include: [], exclude: [] }];
    await writeJson(workspace.sourcesPath, sources);

    await ingestSource(workspace, sources[0]!);
    const nextManifest = { ...oldManifest, model: "new-model", dim: 5, updated_at: new Date().toISOString() };
    await rebuildWorkspaceIndexForModel(workspace, nextManifest, sources);

    assert.equal((await loadManifest(workspace)).model, "new-model");
    assert.equal((await loadIndexStats(workspace, "new-model", 5)).dim, 5);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuildWorkspaceIndexForModel leaves the old manifest when rebuild fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-rebuild-fail-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "note.md"), "# Alpha\n\nalpha beta gamma\n", "utf8");
    const oldManifest = manifest("old-model", 3);
    await writeJson(workspace.manifestPath, oldManifest);
    await writeJson(workspace.configPath, defaultConfig);
    const sources: SourceEntry[] = [{ path: ".", kind: "workspace", include: [], exclude: [] }];
    await writeJson(workspace.sourcesPath, sources);
    await ingestSource(workspace, sources[0]!);

    await assert.rejects(
      () => rebuildWorkspaceIndexForModel(workspace, { ...oldManifest, model: "new-model", dim: 5 }, [
        { path: "missing", kind: "workspace", include: [], exclude: [] }
      ]),
      /ENOENT|no such|cannot find/i
    );

    assert.equal((await loadManifest(workspace)).model, "old-model");
    assert.equal((await loadIndexStats(workspace, "old-model", 3)).dim, 3);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("removeSource can delete an external import snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-remove-import-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    const importFiles = path.join(workspace.kbxDir, "imports", "abc", "files");
    await mkdir(importFiles, { recursive: true });
    await writeFile(path.join(importFiles, "note.md"), "# Imported\n\nprivate note\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("old-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = {
      path: ".kbx/imports/abc/files",
      kind: "external_import",
      include: [],
      exclude: [],
      original_path: path.join(os.tmpdir(), "private-notes"),
      imported_at: "2026-04-30T00:00:00.000Z"
    };
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    const result = await removeSource(workspace, "1", { deleteImportSnapshot: true });

    assert.equal(result.deletedImportSnapshot, true);
    await assert.rejects(() => readFile(path.join(workspace.kbxDir, "imports", "abc", "files", "note.md")), /ENOENT/);
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
