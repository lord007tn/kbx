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

test("listIndexableFiles reads managed imports only when explicitly requested", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-files-"));
  try {
    const importRoot = path.join(root, ".kbx", "imports", "abc", "files");
    await mkdir(importRoot, { recursive: true });
    await writeFile(path.join(root, ".gitignore"), ".kbx/\n", "utf8");
    await writeFile(path.join(importRoot, "note.md"), "# Imported\n", "utf8");

    const workspaceScan = await listIndexableFiles(root, ".");
    assert.deepEqual(workspaceScan.map((file) => file.relativePath), []);

    const importScan = await listIndexableFiles(root, ".kbx/imports/abc/files", { includeKbxImports: true });
    assert.deepEqual(importScan.map((file) => file.relativePath), [".kbx/imports/abc/files/note.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listIndexableFiles applies include, exclude, and gitignore overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-files-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "notes/\n", "utf8");
    await writeFile(path.join(root, "docs", "keep.md"), "# Keep\n", "utf8");
    await writeFile(path.join(root, "docs", "skip.md"), "# Skip\n", "utf8");
    await writeFile(path.join(root, "notes", "ignored.md"), "# Ignored\n", "utf8");

    const narrowed = await listIndexableFiles(root, ".", {
      include: ["docs/**"],
      exclude: ["docs/skip.md"]
    });
    assert.deepEqual(narrowed.map((file) => file.relativePath), ["docs/keep.md"]);

    const withoutGitignore = await listIndexableFiles(root, ".", { useGitignore: false });
    assert.equal(withoutGitignore.some((file) => file.relativePath === "notes/ignored.md"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
