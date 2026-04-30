import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coversSource, normalizeSources, sourceForIngestTarget, sourceForTarget } from "../src/sources.js";
import { workspaceFromRoot } from "../src/workspace.js";

test("sourceForTarget rejects external paths", () => {
  assert.throws(() => {
    sourceForTarget(path.resolve("workspace"), path.resolve("outside"));
  }, /inside the initialized workspace/);
});

test("normalizeSources keeps broader roots over covered children", () => {
  const normalized = normalizeSources([
    { path: "docs", kind: "workspace", include: [], exclude: [] },
    { path: ".", kind: "workspace", include: [], exclude: [] }
  ]);

  assert.deepEqual(normalized.map((source) => source.path), ["."]);
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

    const source = await sourceForIngestTarget(workspace, external, true);
    assert.equal(source.kind, "external_import");
    assert.match(source.path, /^\.kbx\/imports\/[a-f0-9]+\/files$/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
