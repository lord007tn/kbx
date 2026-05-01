#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";

const exec = promisify(execFile);
const artifact = process.argv[2] ?? await findLocalArtifact();
const root = await mkdtemp(path.join(os.tmpdir(), "kbx-artifact-smoke-"));

try {
  await extractArtifact(artifact, root);
  const packageRoot = await findPackageRoot(root);
  const launcher = process.platform === "win32"
    ? path.join(packageRoot, "bin", "kbx.cmd")
    : path.join(packageRoot, "bin", "kbx");
  const command = process.platform === "win32" ? "cmd.exe" : launcher;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", launcher, "--version"] : ["--version"];
  const { stdout } = await exec(command, args, { cwd: root, windowsHide: true });
  if (!stdout.trim()) {
    throw new Error("artifact kbx --version returned empty output");
  }
  console.log(stdout.trim());
} finally {
  await rm(root, { recursive: true, force: true });
}

async function findLocalArtifact() {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const platform = process.env.KBX_PACKAGE_PLATFORM ?? os.platform();
  const arch = process.env.KBX_PACKAGE_ARCH ?? os.arch();
  const extension = platform === "win32" ? "zip" : "tar.gz";
  return path.join("dist", "artifacts", `kbx-v${packageJson.version}-${platform}-${arch}.${extension}`);
}

async function extractArtifact(artifactPath, destination) {
  if (artifactPath.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await readFile(artifactPath));
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) {
        await mkdir(path.join(destination, name), { recursive: true });
      } else {
        const output = path.join(destination, name);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, await entry.async("nodebuffer"));
      }
    }
    return;
  }

  if (artifactPath.endsWith(".tar.gz")) {
    await exec("tar", ["-xzf", path.resolve(artifactPath), "-C", destination], { windowsHide: true });
    return;
  }

  await new Promise((resolve, reject) => {
    const stream = createReadStream(artifactPath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.resume();
  });
  throw new Error(`Unsupported artifact format: ${artifactPath}`);
}

async function findPackageRoot(root) {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const expected = path.join(root, `kbx-v${packageJson.version}-${process.env.KBX_PACKAGE_PLATFORM ?? os.platform()}-${process.env.KBX_PACKAGE_ARCH ?? os.arch()}`);
  try {
    await readFile(path.join(expected, "package.json"), "utf8");
    return expected;
  } catch {
    return root;
  }
}
