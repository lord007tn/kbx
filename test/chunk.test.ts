import assert from "node:assert/strict";
import test from "node:test";
import { chunkMarkdown, chunkSentences } from "../src/chunk";

test("chunkMarkdown removes frontmatter and chunks markdown text", () => {
  const chunks = chunkMarkdown({
    source: "notes/example.md",
    content: "---\ntitle: Example\n---\n# Example\n\nThis is a markdown note with enough content to split cleanly across chunks.",
    maxChars: 40,
    overlapChars: 5
  });

  assert.equal(chunks.length > 1, true);
  assert.equal(chunks[0]?.chunk_idx, 0);
  assert.equal(chunks.some((chunk) => chunk.text.includes("title: Example")), false);
});

test("chunkMarkdown returns stable chunk ids", () => {
  const first = chunkMarkdown({
    source: "notes/example.md",
    content: "# Example\n\nA short note.",
    maxChars: 800,
    overlapChars: 100
  });
  const second = chunkMarkdown({
    source: "notes/example.md",
    content: "# Example\n\nA short note.",
    maxChars: 800,
    overlapChars: 100
  });

  assert.equal(first[0]?.id, second[0]?.id);
});

test("chunkMarkdown starts overlapped chunks on word boundaries", () => {
  const chunks = chunkMarkdown({
    source: "notes/example.md",
    content: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
    maxChars: 28,
    overlapChars: 7
  });

  assert.equal(chunks.length > 1, true);
  for (const chunk of chunks.slice(1)) {
    assert.match(chunk.text, /^[a-z]/);
    assert.doesNotMatch(chunk.text, /^[a-z]{1,2}\s/);
  }
});

test("chunkMarkdown makes progress through long runs without whitespace", () => {
  const chunks = chunkMarkdown({
    source: "notes/long-token.md",
    content: "a".repeat(2_500),
    maxChars: 800,
    overlapChars: 100
  });

  assert.equal(chunks.length, 4);
  assert.equal(chunks.at(-1)?.text.length, 400);
});

test("chunkMarkdown prefers heading sections before fixed splitting", () => {
  const chunks = chunkMarkdown({
    source: "notes/headings.md",
    content: "# One\n\nalpha\n\n## Two\n\nbeta",
    maxChars: 800,
    overlapChars: 100
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.text.includes("# One"), true);
  assert.equal(chunks[0]?.text.includes("## Two"), false);
  assert.equal(chunks[1]?.chunk_idx, 1);
});

test("chunkSentences groups complete sentences", () => {
  const chunks = chunkSentences({
    source: "notes/sentences.md",
    content: "Alpha is first. Beta is second. Gamma is third.",
    maxChars: 32,
    overlapChars: 5
  });

  assert.deepEqual(chunks.map((chunk) => chunk.text), ["Alpha is first. Beta is second.", "Gamma is third."]);
  assert.equal(chunks[1]?.chunk_idx, 1);
});
