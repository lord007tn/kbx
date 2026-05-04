#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const runKbx = (args, options = {}) => exec(npmCommand, [...npmPrefix, "exec", "--yes", "--package", tarball, "--", "kbx", ...args], {
    cwd: options.cwd ?? root,
    env: options.env ?? installEnv,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });

  const { stdout } = await runKbx(["--version"]);
  if (!stdout.trim()) {
    throw new Error("kbx --version returned empty output");
  }
  if (stdout.trim() !== packageJson.version) {
    throw new Error(`kbx --version returned ${stdout.trim()} but package.json is ${packageJson.version}`);
  }

  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const modelCache = path.join(root, "models");
  const workflowEnv = {
    ...installEnv,
    KBX_EMBEDDER: "hash",
    KBX_HOME: home,
    KBX_MODEL_CACHE: modelCache
  };
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "notes.md"), "# Notes\n\nPackaged kbx can index and search local retrieval citations.\n", "utf8");

  const { stdout: initStdout } = await runKbx(["init", "--here", "--model", "minilm"], { cwd: workspace, env: workflowEnv });
  if (!/Initialized/.test(initStdout)) {
    throw new Error(`kbx init did not initialize a workspace:\n${initStdout}`);
  }

  const { stdout: ingestStdout } = await runKbx(["ingest"], { cwd: workspace, env: workflowEnv });
  if (!/Indexed 1 file\(s\), 1 new chunk\(s\)/.test(ingestStdout)) {
    throw new Error(`kbx ingest did not index the smoke file:\n${ingestStdout}`);
  }

  const { stdout: searchStdout } = await runKbx(["search", "retrieval citations", "-k", "3"], { cwd: workspace, env: workflowEnv });
  if (!/notes\.md#0/.test(searchStdout) || !/Packaged kbx can index/.test(searchStdout)) {
    throw new Error(`kbx search did not return the indexed smoke file:\n${searchStdout}`);
  }

  console.log(stdout.trim());
  console.log("Packaged CLI workflow smoke passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
