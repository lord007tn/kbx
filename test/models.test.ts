import assert from "node:assert/strict";
import test from "node:test";
import { resolveModel } from "../src/models.js";

test("resolveModel resolves catalog IDs and model names", () => {
  assert.equal(resolveModel("minilm").dim, 384);
  assert.equal(resolveModel("Xenova/all-MiniLM-L6-v2").id, "minilm");
});

test("resolveModel rejects unknown models", () => {
  assert.throws(() => resolveModel("unknown"), /Unknown model/);
});
