import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cachedModelBenchmark, isCatalogModelInstalled, loadCatalogModelFromPath, MODEL_CATALOG, modelDetails, modelBenchmarkCachePath, resolveModel, saveModelBenchmarkResult } from "../src/models";

test("resolveModel resolves catalog IDs and model names", () => {
  assert.equal(resolveModel("minilm").dim, 384);
  assert.equal(resolveModel("Xenova/all-MiniLM-L6-v2").id, "minilm");
});

test("resolveModel rejects unknown models", () => {
  assert.throws(() => resolveModel("unknown"), /Unknown model/);
});

test("model catalog includes user-facing selection metadata", () => {
  for (const model of MODEL_CATALOG) {
    assert.ok(model.accuracy.length > 0);
    assert.ok(model.size.length > 0);
    assert.ok(model.speed.length > 0);
    assert.ok(model.memory.length > 0);
    assert.ok(model.languages.length > 0);
    assert.ok(model.bestFor.length > 0);
    assert.match(modelDetails(model), /accuracy/);
    assert.match(modelDetails(model), /\|/);
  }
});

test("model benchmark cache is user-level and keyed by machine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-model-cache-"));
  const previousKbxHome = process.env.KBX_HOME;
  process.env.KBX_HOME = root;
  try {
    await saveModelBenchmarkResult({
      model: "test-model",
      dim: 3,
      platform: process.platform,
      arch: process.arch,
      measured_at: "2026-04-30T00:00:00.000Z",
      samples: 5,
      elapsed_ms: 100,
      chunks_per_second: 50
    });

    assert.equal(modelBenchmarkCachePath(), path.join(root, "model-benchmarks.json"));
    assert.equal((await cachedModelBenchmark("test-model", 3))?.chunks_per_second, 50);
    assert.equal(await cachedModelBenchmark("test-model", 4), undefined);
  } finally {
    if (previousKbxHome === undefined) {
      delete process.env.KBX_HOME;
    } else {
      process.env.KBX_HOME = previousKbxHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("loadCatalogModelFromPath copies a local model into the configured cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-model-load-"));
  const previousCache = process.env.KBX_MODEL_CACHE;
  process.env.KBX_MODEL_CACHE = path.join(root, "cache");
  try {
    const source = path.join(root, "model");
    await mkdir(path.join(source, "onnx"), { recursive: true });
    await writeFile(path.join(source, "config.json"), "{}", "utf8");
    await writeFile(path.join(source, "onnx", "model.onnx"), "fake", "utf8");

    const model = resolveModel("minilm");
    const destination = await loadCatalogModelFromPath(model, source);

    assert.equal(await isCatalogModelInstalled(model), true);
    assert.equal(await readFile(path.join(destination, "onnx", "model.onnx"), "utf8"), "fake");
  } finally {
    if (previousCache === undefined) {
      delete process.env.KBX_MODEL_CACHE;
    } else {
      process.env.KBX_MODEL_CACHE = previousCache;
    }
    await rm(root, { recursive: true, force: true });
  }
});
