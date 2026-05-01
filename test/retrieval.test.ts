import assert from "node:assert/strict";
import test from "node:test";
import { lexicalEnhancementScore, queryTerms, rerankSearchHits, snippetForQuery } from "../src/retrieval";
import type { SearchHit } from "../src/types";

test("queryTerms normalizes and deduplicates query tokens", () => {
  assert.deepEqual(queryTerms("Auth auth timeout_ms"), ["auth", "timeout_ms"]);
});

test("lexicalEnhancementScore boosts phrases and proximity", () => {
  const terms = queryTerms("session timeout");
  const adjacent = lexicalEnhancementScore({
    query: "session timeout",
    terms,
    source: "docs/auth.md",
    text: "The session timeout is configured here."
  });
  const distant = lexicalEnhancementScore({
    query: "session timeout",
    terms,
    source: "docs/auth.md",
    text: `session ${"filler ".repeat(80)} timeout`
  });

  assert.ok(adjacent > distant);
});

test("snippetForQuery centers preview around the first matching term", () => {
  const text = `${"intro ".repeat(80)}needle phrase ${"tail ".repeat(80)}`;
  const snippet = snippetForQuery(text, "needle phrase", 80);

  assert.match(snippet, /needle phrase/);
  assert.equal(snippet.startsWith("..."), true);
  assert.equal(snippet.endsWith("..."), true);
  assert.ok(snippet.length <= 90);
});

test("rerankSearchHits promotes exact and proximate matches", () => {
  const hits: SearchHit[] = [
    hit("a", "docs/general.md", "session is mentioned far away " + "x ".repeat(80) + "timeout"),
    hit("b", "docs/auth.md", "session timeout configuration")
  ];

  const ranked = rerankSearchHits("session timeout", hits);

  assert.equal(ranked[0]?.id, "b");
  assert.match(ranked[0]?.snippet ?? "", /session timeout/);
});

function hit(id: string, source: string, text: string): SearchHit {
  return {
    id,
    source,
    citation_source: source,
    chunk_idx: 0,
    score: 0.2,
    text,
    match: "lexical"
  };
}
