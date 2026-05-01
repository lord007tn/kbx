import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chunkId } from "../src/chunk";
import { ChunkVectorStore } from "../src/vector-store";
import { workspaceFromRoot } from "../src/workspace";

test("ChunkVectorStore upserts, searches, and deletes chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-vector-store-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await ChunkVectorStore.open(workspace, 3);
    try {
      store.upsertChunks([
        {
          id: "alpha-0",
          text: "alpha note",
          source: "alpha.md",
          human_source: "alpha.md",
          citation_source: "alpha.md",
          source_origin: "workspace",
          chunk_idx: 0,
          mtime: 1,
          tags: "",
          embedding: [1, 0, 0]
        },
        {
          id: "beta-0",
          text: "beta note",
          source: "beta.md",
          human_source: "beta.md",
          citation_source: "beta.md",
          source_origin: "workspace",
          chunk_idx: 0,
          mtime: 1,
          tags: "",
          embedding: [0, 1, 0]
        }
      ]);

      const hits = store.search([1, 0, 0], 2);
      assert.equal(hits[0]?.id, "alpha-0");
      assert.equal(hits[0]?.score, 1);
      assert.equal(hits[0]?.citation_source, "alpha.md");

      store.deleteSource("alpha.md");
      const afterDelete = store.search([1, 0, 0], 2);
      assert.equal(afterDelete.some((hit) => hit.id === "alpha-0"), false);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ChunkVectorStore lists source chunks above scalar query limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-vector-store-list-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await ChunkVectorStore.open(workspace, 3);
    try {
      store.upsertChunks(Array.from({ length: 1_025 }, (_, index) => ({
        id: chunkId("large.md", index),
        text: `large chunk ${index}`,
        source: "large.md",
        human_source: "large.md",
        citation_source: "large.md",
        source_origin: "workspace",
        chunk_idx: index,
        mtime: 1,
        tags: "",
        embedding: [1, 0, 0]
      })));

      const chunks = store.listSourceChunks("large.md", 1_025);

      assert.equal(chunks.length, 1_025);
      assert.equal(chunks[0]?.chunk_idx, 0);
      assert.equal(chunks.at(-1)?.chunk_idx, 1_024);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
