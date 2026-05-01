import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRetrieval, parseRetrievalEvalCorpus } from "../src/retrieval-eval";

test("parseRetrievalEvalCorpus validates corpus shape", () => {
  const cases = parseRetrievalEvalCorpus(JSON.stringify([
    { id: "auth", query: "session timeout", relevant: ["docs/auth.md"] }
  ]));

  assert.deepEqual(cases, [
    { id: "auth", query: "session timeout", relevant: ["docs/auth.md"] }
  ]);
  assert.throws(() => parseRetrievalEvalCorpus("{}"), /JSON array/);
  assert.throws(() => parseRetrievalEvalCorpus(JSON.stringify([{ id: "bad" }])), /id, query, and relevant/);
});

test("evaluateRetrieval computes MRR, recall, and hit rate", () => {
  const summary = evaluateRetrieval([
    { id: "one", query: "alpha", relevant: ["a.md"] },
    { id: "two", query: "beta", relevant: ["c.md", "d.md"] }
  ], new Map([
    ["one", [{ source: "x.md" }, { source: "a.md" }]],
    ["two", [{ source: "c.md" }, { source: "z.md" }]]
  ]), 2);

  assert.equal(summary.cases, 2);
  assert.equal(summary.meanReciprocalRank, 0.75);
  assert.equal(summary.recallAtK, 0.75);
  assert.equal(summary.hitRate, 1);
});

test("evaluateRetrieval does not inflate recall for duplicate source hits", () => {
  const summary = evaluateRetrieval([
    { id: "one", query: "alpha", relevant: ["a.md"] }
  ], new Map([
    ["one", [{ source: "a.md" }, { source: "a.md" }, { source: "a.md" }]]
  ]), 3);

  assert.equal(summary.results[0]?.recall, 1);
  assert.equal(summary.recallAtK, 1);
});
