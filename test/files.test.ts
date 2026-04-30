import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listIndexableFiles } from "../src/files";

test("listIndexableFiles includes text/code files and excludes built artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-files-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "notes.md"), "# Notes\n", "utf8");
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(root, "dist", "bundle.js"), "generated();\n", "utf8");
    await writeFile(path.join(root, "image.png"), "not really an image", "utf8");

    const files = await listIndexableFiles(root, ".");
    assert.deepEqual(files.map((file) => file.relativePath), ["notes.md", "src/index.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
