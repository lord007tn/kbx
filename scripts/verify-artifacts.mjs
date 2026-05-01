#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { missingRuntimeArchiveEntries, requiredRuntimeArchiveEntries, runtimeArchiveFormat } from "./release-utils.mjs";

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
  const missing = format === "zip"
    ? missingRuntimeArchiveEntries(name, await zipEntries(artifactPath))
    : await missingTarRuntimeEntries(artifactPath, name);
  if (missing.length > 0) {
    throw new Error(`Artifact ${name} is missing required runtime content: ${missing.join(", ")}`);
  }
}

async function zipEntries(artifactPath) {
  const zip = await JSZip.loadAsync(await readFile(artifactPath));
  return Object.keys(zip.files);
}

async function missingTarRuntimeEntries(artifactPath, name) {
  const missing = new Set(requiredRuntimeArchiveEntries(name));
  let buffered = "";
  const child = spawn("tar", ["-tzf", path.resolve(artifactPath)], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const stderr = [];

  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      consumeTarEntry(missing, line);
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (buffered) {
    consumeTarEntry(missing, buffered);
  }
  if (code !== 0) {
    throw new Error(`tar exited with ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  }
  return [...missing];
}

function consumeTarEntry(missing, entry) {
  for (const required of [...missing]) {
    if (required.endsWith("/") ? entry === required || entry.startsWith(required) : entry === required) {
      missing.delete(required);
    }
  }
}
