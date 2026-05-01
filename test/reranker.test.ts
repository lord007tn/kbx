import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyOptionalReranker, parseCommandLine, runCommandReranker, runModelReranker } from "../src/reranker";
import type { SearchHit } from "../src/types";

test("parseCommandLine preserves quoted arguments", () => {
  assert.deepEqual(parseCommandLine('node "scripts/my reranker.mjs" --flag'), ["node", "scripts/my reranker.mjs", "--flag"]);
});

test("runCommandReranker reads JSON scores from an external command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-reranker-"));
  try {
    const script = path.join(root, "rerank.mjs");
    await writeFile(script, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const parsed = JSON.parse(input);
const scores = Object.fromEntries(parsed.candidates.map((candidate, index) => [candidate.id, index === 1 ? 10 : 1]));
process.stdout.write(JSON.stringify({ scores }));
`, "utf8");

    const scores = await runCommandReranker(`"${process.execPath}" "${script}"`, {
      query: "target",
      candidates: [
        { id: "a", source: "a.md", chunk_idx: 0, score: 0.1, text: "alpha" },
        { id: "b", source: "b.md", chunk_idx: 0, score: 0.1, text: "beta" }
      ]
    });

    assert.equal(scores.get("b"), 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyOptionalReranker is disabled by default and reorders when requested", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-optional-reranker-"));
  try {
    const hits = [hit("a"), hit("b")];
    assert.deepEqual(await applyOptionalReranker("query", hits), hits);

    const script = path.join(root, "rerank.mjs");
    await writeFile(script, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify([{ id: "b", score: 2 }, { id: "a", score: 1 }])));
`, "utf8");
    const ranked = await applyOptionalReranker("query", hits, {
      mode: "command",
      command: `"${process.execPath}" "${script}"`
    });

    assert.equal(ranked[0]?.id, "b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyOptionalReranker accepts explicit local mode", async () => {
  const hits = [hit("a"), hit("b")];

  assert.deepEqual(await applyOptionalReranker("query", hits, { mode: "local" }), hits);
});

test("runModelReranker supports deterministic hash model for tests", async () => {
  const scores = await runModelReranker("target token", [
    { id: "a", source: "a.md", chunk_idx: 0, score: 0.1, text: "unrelated" },
    { id: "b", source: "b.md", chunk_idx: 0, score: 0.1, text: "target token appears here" }
  ], "hash");

  assert.equal(scores.get("a"), 0);
  assert.equal(scores.get("b"), 2);
});

test("applyOptionalReranker reorders with model mode", async () => {
  const ranked = await applyOptionalReranker("target", [
    { ...hit("a"), text: "unrelated" },
    { ...hit("b"), text: "target" }
  ], {
    mode: "model",
    model: "hash"
  });

  assert.equal(ranked[0]?.id, "b");
});

function hit(id: string): SearchHit {
  return {
    id,
    source: `${id}.md`,
    citation_source: `${id}.md`,
    chunk_idx: 0,
    score: 0.1,
    text: id,
    match: "vector"
  };
}
