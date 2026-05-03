import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ingestSource } from "../src/indexer";
import { writeJson } from "../src/io";
import { searchRegisteredWorkspaces, searchWorkspace } from "../src/search";
import { SCHEMA_VERSION, type RegistryEntry, type SourceEntry, type WorkspaceManifest } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

const exec = promisify(execFile);

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

test("searchWorkspace uses indexed lexical content instead of rereading live files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-search-indexed-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const notePath = path.join(root, "note.md");
    await writeFile(notePath, "# Original\n\nstable indexed token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    await writeFile(notePath, "# Edited\n\nlive only token\n", "utf8");

    const staleHits = await searchWorkspace(workspace, "stable indexed token", 3);
    const liveHits = await searchWorkspace(workspace, "live only token", 3);

    assert.equal(staleHits[0]?.source, "note.md");
    assert.equal(liveHits.some((hit) => hit.source === "note.md" && hit.text.includes("live only token")), false);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("searchWorkspace reflects lexical changes after reingest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-search-reingest-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const notePath = path.join(root, "note.md");
    await writeFile(notePath, "# Original\n\nold lexical token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    await writeFile(notePath, "# Edited\n\nnew lexical token\n", "utf8");
    await ingestSource(workspace, source);

    const oldHits = await searchWorkspace(workspace, "old lexical token", 3);
    const newHits = await searchWorkspace(workspace, "new lexical token", 3);

    assert.equal(oldHits.some((hit) => hit.source === "note.md" && hit.text.includes("old lexical token")), false);
    assert.equal(newHits[0]?.source, "note.md");
    assert.match(newHits[0]?.text ?? "", /new lexical token/);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("searchWorkspace drops lexical hits for deleted files after reingest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-search-delete-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const notePath = path.join(root, "note.md");
    await writeFile(notePath, "# Deleted\n\ndeleted lexical token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    await rm(notePath);
    await ingestSource(workspace, source);

    const hits = await searchWorkspace(workspace, "deleted lexical token", 3);

    assert.equal(hits.some((hit) => hit.source === "note.md"), false);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("searchWorkspace returns query-centered snippets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-search-snippet-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "long.md"), `# Long\n\n${"intro ".repeat(120)}needle phrase ${"tail ".repeat(120)}\n`, "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);
    await ingestSource(workspace, source);

    const hits = await searchWorkspace(workspace, "needle phrase", 3);

    assert.equal(hits[0]?.source, "long.md");
    assert.match(hits[0]?.snippet ?? "", /needle phrase/);
    assert.equal(hits[0]?.snippet?.startsWith("..."), true);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("searchRegisteredWorkspaces searches every registered workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-global-search-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  const previousHome = process.env.KBX_HOME;
  const home = path.join(root, "home");
  process.env.KBX_EMBEDDER = "hash";
  process.env.KBX_HOME = home;
  try {
    const alphaRoot = path.join(root, "alpha");
    const betaRoot = path.join(root, "beta");
    const alpha = workspaceFromRoot(alphaRoot);
    const beta = workspaceFromRoot(betaRoot);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await mkdir(alpha.kbxDir, { recursive: true });
    await mkdir(beta.kbxDir, { recursive: true });
    await writeFile(path.join(alphaRoot, "alpha.md"), "# Alpha\n\nglobal shared token alpha\n", "utf8");
    await writeFile(path.join(betaRoot, "beta.md"), "# Beta\n\nglobal shared token beta\n", "utf8");
    await writeJson(alpha.manifestPath, { ...manifest("test-model", 3), workspace_id: "alpha-workspace", name: "alpha" });
    await writeJson(beta.manifestPath, { ...manifest("test-model", 3), workspace_id: "beta-workspace", name: "beta" });
    await writeJson(alpha.configPath, defaultConfig);
    await writeJson(beta.configPath, defaultConfig);
    await writeJson(alpha.sourcesPath, [source]);
    await writeJson(beta.sourcesPath, [source]);
    await ingestSource(alpha, source);
    await ingestSource(beta, source);
    await mkdir(home, { recursive: true });
    await writeJson(path.join(home, "registry.json"), [
      registryEntry("alpha-workspace", "alpha", alphaRoot),
      registryEntry("beta-workspace", "beta", betaRoot)
    ]);

    const hits = await searchRegisteredWorkspaces("global shared token", 10);

    assert.deepEqual([...new Set(hits.map((hit) => hit.workspace.name))].sort(), ["alpha", "beta"]);
    assert.equal(hits.some((hit) => hit.source.startsWith("alpha:")), true);
    assert.equal(hits.some((hit) => hit.source.startsWith("beta:")), true);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    restoreEnv("KBX_HOME", previousHome);
    await rm(root, { recursive: true, force: true });
  }
});

test("searchWorkspace scopes indexed workspace content to the checked out Git branch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-branch-search-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "kbx@example.test"]);
    await git(root, ["config", "user.name", "kbx tests"]);

    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);

    await writeFile(path.join(root, "note.md"), "# Main\n\nmain branch unique token\n", "utf8");
    await git(root, ["add", "note.md"]);
    await git(root, ["commit", "-m", "main note"]);
    await ingestSource(workspace, source);

    await git(root, ["checkout", "-b", "feature"]);
    await writeFile(path.join(root, "note.md"), "# Feature\n\nfeature branch unique token\n", "utf8");
    await git(root, ["add", "note.md"]);
    await git(root, ["commit", "-m", "feature note"]);
    await ingestSource(workspace, source);

    const featureHits = await searchWorkspace(workspace, "feature branch unique token", 3);
    const featureMainHits = await searchWorkspace(workspace, "main branch unique token", 3);
    assert.equal(featureHits[0]?.source, "note.md");
    assert.equal(featureHits[0]?.branch_name, "feature");
    assert.equal(featureMainHits.some((hit) => hit.text.includes("main branch unique token")), false);

    await git(root, ["checkout", "main"]);
    const mainHits = await searchWorkspace(workspace, "main branch unique token", 3);
    const mainFeatureHits = await searchWorkspace(workspace, "feature branch unique token", 3);
    assert.equal(mainHits[0]?.source, "note.md");
    assert.equal(mainHits[0]?.branch_name, "main");
    assert.equal(mainFeatureHits.some((hit) => hit.text.includes("feature branch unique token")), false);
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

function registryEntry(workspace_id: string, name: string, workspacePath: string): RegistryEntry {
  return {
    workspace_id,
    name,
    path: workspacePath,
    created_at: "2026-05-01T00:00:00.000Z",
    last_seen_at: "2026-05-01T00:00:00.000Z"
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", ["-C", cwd, ...args], { windowsHide: true });
}
