import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { coversSource, normalizeSources, sourceForTarget } from "../src/sources.js";

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
