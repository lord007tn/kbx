#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const npmCommand = process.env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmPrefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];
const maxPackageSizeBytes = Number.parseInt(process.env.KBX_NPM_PACK_MAX_BYTES ?? "1048576", 10);
const allowedFiles = new Set([
  "LICENSE",
  "README.md",
  "dist/cli.d.mts",
  "dist/cli.mjs",
  "package.json"
]);

const { stdout } = await exec(npmCommand, [...npmPrefix, "pack", "--dry-run", "--json"], { windowsHide: true });
const pack = JSON.parse(stdout)[0];
if (!pack || !Array.isArray(pack.files)) {
  throw new Error("npm pack --dry-run did not return package file metadata.");
}

const files = pack.files.map((entry) => entry.path);
const unexpected = files.filter((file) => !allowedFiles.has(file));
const missing = [...allowedFiles].filter((file) => !files.includes(file));

if (unexpected.length > 0) {
  throw new Error(`npm package includes unexpected files: ${unexpected.join(", ")}`);
}
if (missing.length > 0) {
  throw new Error(`npm package is missing required files: ${missing.join(", ")}`);
}
if (pack.size > maxPackageSizeBytes) {
  throw new Error(`npm package is too large: ${pack.size} bytes exceeds ${maxPackageSizeBytes} bytes.`);
}

console.log(`Verified npm package contents: ${files.length} files, ${pack.size} bytes.`);
