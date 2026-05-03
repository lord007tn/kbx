#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "kbx-smoke-install-"));
const npmCommand = process.env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmPrefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const installEnv = {
  ...process.env,
  ONNXRUNTIME_NODE_INSTALL: process.env.ONNXRUNTIME_NODE_INSTALL ?? "skip"
};

try {
  const { stdout: packStdout } = await exec(npmCommand, [...npmPrefix, "pack", "--json", "--pack-destination", root], { env: installEnv, windowsHide: true });
  const packResult = JSON.parse(packStdout)[0];
  const tarball = path.join(root, packResult.filename);
  const { stdout } = await exec(npmCommand, [...npmPrefix, "exec", "--yes", "--package", tarball, "--", "kbx", "--version"], { env: installEnv, windowsHide: true });
  if (!stdout.trim()) {
    throw new Error("kbx --version returned empty output");
  }
  if (stdout.trim() !== packageJson.version) {
    throw new Error(`kbx --version returned ${stdout.trim()} but package.json is ${packageJson.version}`);
  }
  console.log(stdout.trim());
} finally {
  await rm(root, { recursive: true, force: true });
}
