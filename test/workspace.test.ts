import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findGitRoot, initWorkspace, loadManifest, registryPath, resolveWorkspaceSelector } from "../src/workspace";
import type { RegistryEntry } from "../src/types";

const registry: RegistryEntry[] = [
  {
    workspace_id: "aaa111bbb222",
    name: "app",
    path: "D:\\Work\\app",
    created_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z"
  },
  {
    workspace_id: "ccc333ddd444",
    name: "docs",
    path: "D:\\Work\\docs",
    created_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z"
  }
];

test("resolveWorkspaceSelector resolves short IDs and unique names", () => {
  assert.equal(resolveWorkspaceSelector(registry, "aaa111").workspace_id, "aaa111bbb222");
  assert.equal(resolveWorkspaceSelector(registry, "docs").workspace_id, "ccc333ddd444");
});

test("resolveWorkspaceSelector rejects missing workspaces", () => {
  assert.throws(() => resolveWorkspaceSelector(registry, "missing"), /No registered workspace/);
});

test("resolveWorkspaceSelector rejects ambiguous names", () => {
  assert.throws(
    () => resolveWorkspaceSelector([...registry, { ...registry[1]!, workspace_id: "eee555fff666", name: "app" }], "app"),
    /ambiguous/
  );
});

test("initWorkspace stores an explicitly selected model on first init", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-init-model-"));
  const registryFile = registryPath();
  const originalRegistry = await readFile(registryFile, "utf8").catch(() => null);
  try {
    const workspace = await initWorkspace(root, { model: "Xenova/all-MiniLM-L6-v2", dim: 384 });
    const manifest = await loadManifest(workspace);

    assert.equal(manifest.model, "Xenova/all-MiniLM-L6-v2");
    assert.equal(manifest.dim, 384);
    await assert.rejects(
      () => initWorkspace(root, { model: "nomic-ai/nomic-embed-text-v1.5", dim: 768 }),
      /already initialized/
    );
  } finally {
    if (originalRegistry === null) {
      await rm(registryFile, { force: true });
    } else {
      await writeFile(registryFile, originalRegistry, "utf8");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("findGitRoot walks up to the nearest git directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-git-root-"));
  try {
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, "packages", "app"), { recursive: true });

    assert.equal(await findGitRoot(path.join(root, "packages", "app")), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
