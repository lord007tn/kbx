#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const checksumsPath = process.argv[2] ?? "dist/artifacts/checksums.txt";
const artifactDir = path.dirname(checksumsPath);
const lines = (await readFile(checksumsPath, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (lines.length === 0) {
  throw new Error("No artifacts listed in checksums file.");
}

for (const line of lines) {
  const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
  if (!match) {
    throw new Error(`Invalid checksum line: ${line}`);
  }
  const expected = match[1].toLowerCase();
  const name = match[2];
  const actual = createHash("sha256").update(await readFile(path.join(artifactDir, name))).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${name}`);
  }
}

console.log(`Verified ${lines.length} artifact checksum(s).`);
