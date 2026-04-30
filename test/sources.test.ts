import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await writeFile(path.join(external, "note.md"), "# External\n", "utf8");

    const source = await sourceForIngestTarget(workspace, external, { allowExternal: true });
    assert.equal(source.kind, "external_import");
    assert.match(source.path, /^\.kbx\/imports\/[a-f0-9]+\/files$/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
