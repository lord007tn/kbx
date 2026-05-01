import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestSource, loadIndexStats, rebuildWorkspaceIndexForModel, refreshWorkspaceFreshness, removeSource, resetWorkspaceIndex, scanWorkspaceFreshness, type IngestProgressEvent } from "../src/indexer";
import { writeJson } from "../src/io";
import { LexicalIndexStore } from "../src/lexical-index";
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

test("removeSource deletes matching chunks from the lexical index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-remove-lexical-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "remove.md"), "# Remove\n\nobsolete lexical token\n", "utf8");
    await writeFile(path.join(root, "keep.md"), "# Keep\n\npersistent lexical token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("old-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const sources: SourceEntry[] = [
      { path: "remove.md", kind: "workspace", include: [], exclude: [] },
      { path: "keep.md", kind: "workspace", include: [], exclude: [] }
    ];
    await writeJson(workspace.sourcesPath, sources);
    await ingestSource(workspace, sources[0]!);
    await ingestSource(workspace, sources[1]!);

    await removeSource(workspace, "remove.md");
    const lexical = await LexicalIndexStore.open(workspace, { readOnly: true });
    const obsoleteHits = lexical.search("obsolete", 5);
    const persistentHits = lexical.search("persistent", 5);
    await lexical.close();

    assert.equal(obsoleteHits.length, 0);
    assert.equal(persistentHits[0]?.source, "keep.md");
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("resetWorkspaceIndex removes lexical index data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-reset-lexical-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "note.md"), "# Note\n\nreset lexical token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("old-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    await resetWorkspaceIndex(workspace);

    await assert.rejects(() => access(workspace.lexicalPath), /ENOENT/);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("ingestSource repairs missing lexical rows for unchanged indexed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-repair-lexical-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "note.md"), "# Note\n\nrepair lexical token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("old-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);

    await ingestSource(workspace, source);
    await rm(workspace.lexicalPath, { force: true });

    const result = await ingestSource(workspace, source);
    const lexical = await LexicalIndexStore.open(workspace, { readOnly: true });
    const hits = lexical.search("repair lexical token", 5);
    await lexical.close();

    assert.equal(result.chunks, 0);
    assert.equal(result.skipped, 1);
    assert.equal(hits[0]?.source, "note.md");
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("ingestSource reports scan and per-file progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-ingest-progress-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "a.md"), "# Alpha\n\nalpha beta gamma\n", "utf8");
    await writeFile(path.join(root, "b.md"), "# Beta\n\nbeta gamma delta\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("old-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    const events: IngestProgressEvent[] = [];

    await ingestSource(workspace, source, {
      onProgress: (event) => {
        events.push(event);
      }
    });

    assert.deepEqual(events.map((event) => event.phase), ["scan-start", "scan-complete", "file", "file", "complete"]);
    const scanComplete = events[1];
    assert.equal(scanComplete?.phase, "scan-complete");
    assert.equal(scanComplete.totalFiles, 2);
    const fileEvents = events.filter((event): event is Extract<IngestProgressEvent, { phase: "file" }> => event.phase === "file");
    assert.deepEqual(fileEvents.map((event) => event.processedFiles), [1, 2]);
    const complete = events.at(-1);
    assert.equal(complete?.phase, "complete");
    assert.equal(complete.totalFiles, 2);
    assert.ok(complete.insertedChunks > 0);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("ingestSource skips files deleted after scanning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-ingest-deleted-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const stablePath = path.join(root, "stable.md");
    const deletedPath = path.join(root, "deleted.md");
    await writeFile(stablePath, "# Stable\n\nalpha beta gamma\n", "utf8");
    await writeFile(deletedPath, "# Deleted\n\nthis file goes away\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("old-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    let removed = false;

    const result = await ingestSource(workspace, source, {
      onProgress: async (event) => {
        if (event.phase === "scan-complete" && !removed) {
          removed = true;
          await rm(deletedPath, { force: true });
        }
      }
    });

    assert.equal(result.files, 2);
    assert.equal(result.deleted, 1);
    const stats = await loadIndexStats(workspace, "old-model", 3);
    assert.equal("stable.md" in stats.files, true);
    assert.equal("deleted.md" in stats.files, false);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("scanWorkspaceFreshness and refreshWorkspaceFreshness track indexed file changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-freshness-refresh-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const stalePath = path.join(root, "stale.md");
    const deletedPath = path.join(root, "deleted.md");
    await writeFile(stalePath, "# Stale\n\nold freshness token\n", "utf8");
    await writeFile(deletedPath, "# Deleted\n\ndelete freshness token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("old-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    await waitForMtimeTick();
    await writeFile(stalePath, "# Stale\n\nnew freshness token\n", "utf8");
    await writeFile(path.join(root, "new.md"), "# New\n\nnew file freshness token\n", "utf8");
    await rm(deletedPath);

    const scan = await scanWorkspaceFreshness(workspace);
    assert.equal(scan.stale, 1);
    assert.equal(scan.deleted, 1);
    assert.equal(scan.newFiles, 1);

    const skipped = await refreshWorkspaceFreshness(workspace, { maxChanges: 2 });
    assert.equal(skipped.refreshed, false);
    assert.match(skipped.skipped_reason ?? "", /change_count_exceeded/);

    const refreshed = await refreshWorkspaceFreshness(workspace, { maxChanges: 3 });
    assert.equal(refreshed.refreshed, true);

    const finalScan = await scanWorkspaceFreshness(workspace);
    assert.deepEqual({ stale: finalScan.stale, deleted: finalScan.deleted, newFiles: finalScan.newFiles }, {
      stale: 0,
      deleted: 0,
      newFiles: 0
    });
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("loadIndexStats reports corrupt stats instead of treating them as empty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-stats-corrupt-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(workspace.statsPath, "\0\0\0", "utf8");

    await assert.rejects(
      () => loadIndexStats(workspace, "old-model", 3),
      /Invalid JSON/
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

async function waitForMtimeTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
