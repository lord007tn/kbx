#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { missingRuntimeArchiveEntries, runtimeArchiveFormat } from "../src/distribution.ts";

const exec = promisify(execFile);
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
  await verifyArchiveShape(path.join(artifactDir, name), name);
}

console.log(`Verified ${lines.length} artifact checksum(s).`);

async function verifyArchiveShape(artifactPath, name) {
  const format = runtimeArchiveFormat(name);
  if (!format) {
    throw new Error(`Unsupported release artifact type: ${name}`);
  }
  const entries = format === "zip" ? await zipEntries(artifactPath) : await tarEntries(artifactPath);
  const missing = missingRuntimeArchiveEntries(name, entries);
  if (missing.length > 0) {
    throw new Error(`Artifact ${name} is missing required runtime content: ${missing.join(", ")}`);
  }
}

async function zipEntries(artifactPath) {
  const zip = await JSZip.loadAsync(await readFile(artifactPath));
  return Object.keys(zip.files);
}

async function tarEntries(artifactPath) {
  const { stdout } = await exec("tar", ["-tzf", path.resolve(artifactPath)], { windowsHide: true });
  return stdout.split(/\r?\n/).filter(Boolean);
}
