import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, writeJson } from "../src/io";

test("writeJson writes parseable JSON and cleans temporary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-io-"));
  try {
    const filePath = path.join(root, "nested", "value.json");
    await writeJson(filePath, { ok: true, count: 2 });

    assert.deepEqual(await readJson(filePath), { ok: true, count: 2 });
    assert.equal((await readFile(filePath, "utf8")).endsWith("\n"), true);
    assert.deepEqual(await readdir(path.dirname(filePath)), ["value.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readJson includes the file path in parse errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-io-"));
  try {
    const filePath = path.join(root, "broken.json");
    await writeFile(filePath, "\0", "utf8");

    await assert.rejects(
      () => readJson(filePath),
      new RegExp(`Invalid JSON in ${filePath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
