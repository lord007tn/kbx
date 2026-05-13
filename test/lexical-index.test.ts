import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LexicalIndexStore } from "../src/lexical-index";
import type { ChunkRecord } from "../src/types";
import { workspaceFromRoot } from "../src/workspace";

test("LexicalIndexStore persists and searches indexed chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await LexicalIndexStore.open(workspace);
    store.upsertChunks([
      chunk({ id: "a", source: "api.ts", text: "export const SDM_CLICKHOUSE_TIMEOUT_MS = 8000;" }),
      chunk({ id: "b", source: "notes.md", text: "unrelated release notes" })
    ]);
    await store.close();

    const reopened = await LexicalIndexStore.open(workspace, { readOnly: true });
    const hits = reopened.search("SDM_CLICKHOUSE_TIMEOUT_MS", 5);
    await reopened.close();

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "a");
    assert.equal(hits[0]?.source, "api.ts");
    assert.equal(hits[0]?.match, "lexical");
    await access(workspace.lexicalPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore read-only open does not create a missing index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-readonly-missing-"));
  try {
    const workspace = workspaceFromRoot(root);

    await assert.rejects(
      () => LexicalIndexStore.open(workspace, { readOnly: true }),
      /unable to open database file|cannot open database|no such file/i
    );
    await assert.rejects(() => access(workspace.kbxDir), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore deletes all chunks for a source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-delete-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await LexicalIndexStore.open(workspace);
    store.upsertChunks([
      chunk({ id: "a", source: "old.md", text: "obsolete token" }),
      chunk({ id: "b", source: "keep.md", text: "fresh token" })
    ]);
    store.deleteSource("old.md");
    await store.close();

    const reopened = await LexicalIndexStore.open(workspace, { readOnly: true });
    const obsoleteHits = reopened.search("obsolete", 5);
    const freshHits = reopened.search("fresh", 5);
    await reopened.close();

    assert.equal(obsoleteHits.length, 0);
    assert.equal(freshHits[0]?.source, "keep.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore lists chunks for derived stores", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-all-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await LexicalIndexStore.open(workspace);
    store.upsertChunks([
      chunk({ id: "b", source: "b.md", text: "second" }),
      chunk({ id: "a", source: "a.md", text: "first" })
    ]);

    const chunks = store.allChunks(10);

    assert.deepEqual(chunks.map((record) => record.id), ["a", "b"]);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore tracks content aliases separately from chunk aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-content-alias-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await LexicalIndexStore.open(workspace);
    store.upsertChunks([
      chunk({ id: "a", content_id: "content-a", source: "main.md", text: "shared content token" }),
      chunk({ id: "b", content_id: "content-a", source: "feature.md", text: "shared content token" }),
      chunk({ id: "c", content_id: "content-c", source: "unique.md", text: "unique content token" })
    ]);

    assert.equal(store.chunkCount, 3);
    assert.equal(store.contentCount, 2);
    assert.deepEqual(store.contentIdsForSource("main.md"), ["content-a"]);
    assert.equal(store.hasContent("content-a"), true);
    assert.equal(store.getChunk("b")?.content_id, "content-a");

    store.deleteSource("main.md");
    assert.equal(store.hasContent("content-a"), true);
    store.deleteSource("feature.md");
    assert.equal(store.hasContent("content-a"), false);
    assert.equal(store.contentCount, 1);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore filters content aliases by branch before limiting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-branch-alias-limit-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await LexicalIndexStore.open(workspace);
    store.upsertChunks([
      ...Array.from({ length: 250 }, (_, index) => chunk({
        id: `other-${index}`,
        content_id: "content-shared",
        source: `git:branch%3Aother:a-${String(index).padStart(3, "0")}.md`,
        text: "shared branch alias token",
        tags: JSON.stringify({ branch_scope: "branch:other", branch_name: "other" })
      })),
      chunk({
        id: "wanted",
        content_id: "content-shared",
        source: "git:branch%3Awanted:z-wanted.md",
        text: "shared branch alias token",
        tags: JSON.stringify({ branch_scope: "branch:wanted", branch_name: "wanted" })
      })
    ]);

    const aliases = store.aliasesForContent("content-shared", "branch:wanted", 1);

    assert.equal(aliases.length, 1);
    assert.equal(aliases[0]?.id, "wanted");
    assert.equal(aliases[0]?.branch_name, "wanted");
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore ranks exact phrase and source matches first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-rank-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await LexicalIndexStore.open(workspace);
    store.upsertChunks([
      chunk({ id: "a", source: "general.md", text: `session ${"filler ".repeat(80)} timeout` }),
      chunk({ id: "b", source: "session-timeout.md", text: "session timeout settings" })
    ]);
    await store.close();

    const reopened = await LexicalIndexStore.open(workspace, { readOnly: true });
    const hits = reopened.search("session timeout", 5);
    await reopened.close();

    assert.equal(hits[0]?.id, "b");
    assert.match(hits[0]?.snippet ?? "", /session timeout/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore supports trigram substring matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-trigram-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await LexicalIndexStore.open(workspace);
    store.upsertChunks([
      chunk({ id: "a", source: "api.ts", text: "export const SDM_CLICKHOUSE_TIMEOUT_MS = 8000;" })
    ]);
    await store.close();

    const reopened = await LexicalIndexStore.open(workspace, { readOnly: true });
    const hits = reopened.search("CLICKHOUSE", 5);
    await reopened.close();

    assert.equal(hits[0]?.id, "a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore recovers fuzzy term matches from the SQLite vocabulary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-fuzzy-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    const store = await LexicalIndexStore.open(workspace);
    store.upsertChunks([
      chunk({ id: "a", source: "api.ts", text: "export const SDM_CLICKHOUSE_TIMEOUT_MS = 8000;" })
    ]);
    await store.close();

    const reopened = await LexicalIndexStore.open(workspace, { readOnly: true });
    const hits = reopened.search("CLICKHOUES", 5);
    await reopened.close();

    assert.equal(hits[0]?.id, "a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LexicalIndexStore migrates legacy JSON indexes into SQLite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-lexical-migrate-"));
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(workspace.kbxDir, "lexical-index.json"), JSON.stringify({
      schema_version: 1,
      chunks: [
        chunk({ id: "a", source: "legacy.md", text: "legacy migration token" })
      ]
    }), "utf8");

    const store = await LexicalIndexStore.open(workspace);
    assert.equal(store.chunkCount, 1);
    await store.close();

    const reopened = await LexicalIndexStore.open(workspace, { readOnly: true });
    const hits = reopened.search("legacy migration", 5);
    await reopened.close();

    assert.equal(hits[0]?.source, "legacy.md");
    await access(workspace.lexicalPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function chunk(overrides: { id: string; source: string; text: string; content_id?: string; tags?: string }): ChunkRecord {
  return {
    id: overrides.id,
    content_id: overrides.content_id,
    text: overrides.text,
    source: overrides.source,
    human_source: overrides.source,
    citation_source: overrides.source,
    source_origin: "workspace",
    chunk_idx: 0,
    mtime: 1,
    tags: overrides.tags ?? ""
  };
}
