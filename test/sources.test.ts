import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coversSource, normalizeSources, sourceForIngestTarget, sourceForTarget } from "../src/sources";
import { workspaceFromRoot } from "../src/workspace";

test("sourceForTarget rejects external paths", () => {
  assert.throws(() => {
    sourceForTarget(path.resolve("workspace"), path.resolve("outside"));
  }, /inside the initialized workspace/);
});

test("sourceForTarget records ingest policy overrides", () => {
  const source = sourceForTarget(path.resolve("workspace"), path.resolve("workspace", "docs"), {
    include: ["**/*.md"],
    exclude: ["drafts/**"],
    noGitignore: true
  });

  assert.deepEqual(source.include, ["**/*.md"]);
  assert.deepEqual(source.exclude, ["drafts/**"]);
  assert.equal(source.no_gitignore, true);
});

test("normalizeSources keeps broader roots over covered children", () => {
  const normalized = normalizeSources([
    { path: "docs", kind: "workspace", include: [], exclude: [] },
    { path: ".", kind: "workspace", include: [], exclude: [] }
  ]);

  assert.deepEqual(normalized.map((source) => source.path), ["."]);
});

test("normalizeSources keeps external imports separate from workspace root", () => {
  const normalized = normalizeSources([
    { path: ".", kind: "workspace", include: [], exclude: [] },
    {
      path: ".kbx/imports/abc/files",
      kind: "external_import",
      include: [],
      exclude: [],
      original_path: "/tmp/notes",
      imported_at: "2026-04-30T00:00:00.000Z"
    }
  ]);

  assert.deepEqual(normalized.map((source) => source.path), [".", ".kbx/imports/abc/files"]);
});

test("normalizeSources keeps session memory separate from workspace root", () => {
  const normalized = normalizeSources([
    { path: ".", kind: "workspace", include: [], exclude: [] },
    {
      path: ".kbx/sessions",
      kind: "session_memory",
      include: ["**/*.md"],
      exclude: [],
      retention_days: 30,
      created_at: "2026-05-01T00:00:00.000Z"
    }
  ]);

  assert.deepEqual(normalized.map((source) => source.path), [".", ".kbx/sessions"]);
});

test("coversSource recognizes nested workspace paths", () => {
  assert.equal(coversSource("docs", "docs/adr"), true);
  assert.equal(coversSource("docs", "src"), false);
});

test("sourceForIngestTarget snapshots external paths when allowed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-workspace-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "kbx-external-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await mkdir(path.join(external, "node_modules", "dep"), { recursive: true });
    await mkdir(path.join(external, "secrets"), { recursive: true });
    await writeFile(path.join(external, "note.md"), "# External\n", "utf8");
    await writeFile(path.join(external, "node_modules", "dep", "index.md"), "# Dependency\n", "utf8");
    await writeFile(path.join(external, "secrets", "private.md"), "# Secret\n", "utf8");

    const source = await sourceForIngestTarget(workspace, external, { allowExternal: true });
    assert.equal(source.kind, "external_import");
    assert.match(source.path, /^\.kbx\/imports\/[a-f0-9]+\/files$/);
    await access(path.join(root, source.path, "note.md"));
    await assert.rejects(() => access(path.join(root, source.path, "node_modules", "dep", "index.md")), /ENOENT/);
    await assert.rejects(() => access(path.join(root, source.path, "secrets", "private.md")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("sourceForIngestTarget rejects symlinks and junctions that resolve outside the workspace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-workspace-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "kbx-external-"));
  try {
    const workspace = workspaceFromRoot(root);
    const linked = path.join(root, "linked-notes");
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(external, "outside.md"), "# Outside\n", "utf8");
    try {
      await symlink(external, linked, "junction");
    } catch (error) {
      t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    await assert.rejects(
      () => sourceForIngestTarget(workspace, linked),
      /External paths require --allow-external/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
