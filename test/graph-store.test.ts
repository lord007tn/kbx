import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGraph, graphStats, queryGraph } from "../src/graph-store";
import { writeJson } from "../src/io";
import { LexicalIndexStore } from "../src/lexical-index";
import type { ChunkRecord } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

test("graph store builds deterministic file, heading, symbol, dependency, and memory nodes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-graph-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeJson(workspace.configPath, {
      ...defaultConfig,
      graph: {
        ...defaultConfig.graph,
        enabled: "enabled"
      }
    });
    const lexical = await LexicalIndexStore.open(workspace);
    lexical.upsertChunks([
      chunk({
        id: "source",
        source: "src/session-store.ts",
        text: "# Sessions\n\nexport function startSession() {\n  return true;\n}\n"
      }),
      chunk({
        id: "package",
        source: "package.json",
        text: JSON.stringify({ dependencies: { "better-sqlite3": "^12.9.0" } })
      }),
      chunk({
        id: "memory",
        source: "session-memory:decision.md",
        text: "# Retained decision\n\nDecision: keep graph knowledge deterministic.",
        source_origin: "session_memory"
      })
    ]);
    await lexical.close();

    const built = await buildGraph(workspace);
    const symbolQuery = await queryGraph(workspace, "startSession");
    const packageQuery = await queryGraph(workspace, "better-sqlite3");
    const memoryQuery = await queryGraph(workspace, "deterministic");
    const stats = await graphStats(workspace);

    assert.equal(built.chunks_scanned, 3);
    assert.ok(built.nodes >= 6);
    assert.ok(built.edges >= 4);
    assert.equal(symbolQuery.nodes.some((node) => node.type === "symbol" && node.label === "startSession"), true);
    assert.equal(packageQuery.nodes.some((node) => node.type === "package" && node.label === "better-sqlite3"), true);
    assert.equal(memoryQuery.nodes.some((node) => node.type === "memory"), true);
    assert.equal(stats.nodes, built.nodes);
    assert.equal(stats.edges, built.edges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function chunk(overrides: {
  id: string;
  source: string;
  text: string;
  source_origin?: ChunkRecord["source_origin"];
}): ChunkRecord {
  return {
    id: overrides.id,
    content_id: overrides.id,
    text: overrides.text,
    source: overrides.source,
    human_source: overrides.source,
    citation_source: overrides.source,
    source_origin: overrides.source_origin ?? "workspace",
    chunk_idx: 0,
    mtime: 1,
    tags: ""
  };
}
