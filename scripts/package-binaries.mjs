#!/usr/bin/env node
import { access, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const packageJson = require("../package.json");
const platform = process.env.KBX_PACKAGE_PLATFORM ?? os.platform();
const arch = process.env.KBX_PACKAGE_ARCH ?? os.arch();
const artifactDir = process.argv[2] ?? "dist/artifacts";
const name = platform === "win32"
  ? `kbx-v${packageJson.version}-${platform}-${arch}.zip`
  : `kbx-v${packageJson.version}-${platform}-${arch}.tar.gz`;
const packageRoot = path.join(".release", `kbx-v${packageJson.version}-${platform}-${arch}`);
const artifactPath = path.join(artifactDir, name);

if (platform !== os.platform() || arch !== os.arch()) {
  if (process.env.KBX_ALLOW_CROSS_PACKAGE !== "1") {
    throw new Error(`Refusing to create ${platform}-${arch} artifact on ${os.platform()}-${os.arch()}. Set KBX_ALLOW_CROSS_PACKAGE=1 only for metadata tests.`);
  }
}

await mkdir(artifactDir, { recursive: true });
await rm(packageRoot, { recursive: true, force: true });
await mkdir(path.join(packageRoot, "bin"), { recursive: true });
await mkdir(path.join(packageRoot, "support", "node"), { recursive: true });
await cp("dist", path.join(packageRoot, "dist"), {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}artifacts`) && !source.includes(`${path.sep}homebrew`)
});
await cp("node_modules", path.join(packageRoot, "node_modules"), {
  recursive: true,
  filter: (source) => {
    const normalized = source.replaceAll("\\", "/");
    return !normalized.includes("/.cache/")
      && !normalized.includes("/.vite/")
      && !normalized.includes("/.bin/tsx")
      && !normalized.includes("/.bin/tsc")
      && !normalized.includes("/.bin/tsserver");
  }
});
await cp("package.json", path.join(packageRoot, "package.json"));
await cp("README.md", path.join(packageRoot, "README.md")).catch(() => undefined);
await cp("LICENSE", path.join(packageRoot, "LICENSE")).catch(() => undefined);

if (platform === "win32") {
  await cp(process.execPath, path.join(packageRoot, "support", "node", "node.exe"));
  await writeFile(path.join(packageRoot, "bin", "kbx.cmd"), "@echo off\r\n\"%~dp0\\..\\support\\node\\node.exe\" \"%~dp0\\..\\dist\\cli.mjs\" %*\r\n", "utf8");
  await writeZip(packageRoot, artifactPath);
} else {
  const nodePath = path.join(packageRoot, "support", "node", "node");
  await cp(process.execPath, nodePath);
  await chmod(nodePath, 0o755);
  await copyRuntimeLibraryDirectory(packageRoot);
  const launcher = "#!/usr/bin/env sh\nDIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec \"$DIR/../support/node/node\" \"$DIR/../dist/cli.mjs\" \"$@\"\n";
  const launcherPath = path.join(packageRoot, "bin", "kbx");
  await writeFile(launcherPath, launcher, "utf8");
  await chmod(launcherPath, 0o755);
  await exec("tar", ["-czf", path.resolve(artifactPath), "-C", path.dirname(packageRoot), path.basename(packageRoot)], { windowsHide: true });
}
await maybeSignArtifact(artifactPath);
console.log(artifactPath);

async function writeZip(root, output) {
  const zip = new JSZip();
  await addDirectory(zip, root, path.basename(root));
  await writeFile(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function addDirectory(zip, directory, prefix) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await addDirectory(zip, absolute, relative);
    } else if (entry.isFile()) {
      zip.file(relative, await readFile(absolute));
    }
  }
}

async function copyRuntimeLibraryDirectory(root) {
  const nodeDir = path.dirname(process.execPath);
  for (const candidate of ["lib", "lib64"]) {
    const source = path.join(nodeDir, "..", candidate);
    if (await exists(source)) {
      await cp(source, path.join(root, "support", candidate), { recursive: true });
    }
  }
}

async function maybeSignArtifact(artifactPath) {
  const command = process.env.KBX_SIGN_COMMAND;
  if (!command) {
    if (process.env.KBX_SIGN_REQUIRED === "1") {
      throw new Error("KBX_SIGN_REQUIRED=1 but KBX_SIGN_COMMAND is not set.");
    }
    return;
  }

  const [program, ...args] = parseCommandLine(command).map((part) => part.replaceAll("{artifact}", artifactPath));
  if (!program) {
    throw new Error("KBX_SIGN_COMMAND is empty.");
  }
  await exec(program, args, { windowsHide: true });
}

function parseCommandLine(value) {
  const parts = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (char === "\\" && next && (next === "\\" || next === "\"" || next === "'" || /\s/.test(next))) {
      current += next;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
