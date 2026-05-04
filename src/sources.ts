import path from "node:path";
import crypto from "node:crypto";
import { copyFile, mkdir, realpath, rm, stat } from "node:fs/promises";
import { writeJson } from "./io";
import type { SourceEntry } from "./types";
import { toPosixPath } from "./io";
import type { Workspace } from "./workspace";
import { listIndexableFileEntries } from "./files";

export interface SourcePolicyOptions {
  include?: string[];
  exclude?: string[];
  noGitignore?: boolean;
}

export function sourceForTarget(workspaceRoot: string, target: string, options: SourcePolicyOptions = {}): SourceEntry {
  const relative = path.relative(workspaceRoot, target);
  if (!isPathInside(workspaceRoot, target)) {
    throw new Error("v0.1 only supports ingesting paths inside the initialized workspace");
  }

  return {
    path: relative === "" ? "." : toPosixPath(relative),
    kind: "workspace",
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    no_gitignore: options.noGitignore === true ? true : undefined
  };
}

export async function sourceForIngestTarget(workspace: Workspace, target: string, options: SourcePolicyOptions & { allowExternal?: boolean } = {}): Promise<SourceEntry> {
  const [workspaceRealRoot, targetRealPath] = await Promise.all([
    realpath(workspace.root),
    realpath(target)
  ]);
  if (isPathInside(workspaceRealRoot, targetRealPath)) {
    const relative = path.relative(workspaceRealRoot, targetRealPath);
    return workspaceSourceFromRelative(relative, options);
  }

  if (options.allowExternal !== true) {
    throw new Error("External paths require --allow-external");
  }

  const absoluteTarget = targetRealPath;
  const hash = crypto.createHash("sha256").update(absoluteTarget).digest("hex").slice(0, 16);
  const importRoot = path.join(workspace.kbxDir, "imports", hash);
  const filesRoot = path.join(importRoot, "files");
  await rm(importRoot, { recursive: true, force: true });
  await mkdir(filesRoot, { recursive: true });

  const targetInfo = await stat(absoluteTarget);
  if (targetInfo.isDirectory()) {
    await copyIndexableExternalFiles(absoluteTarget, ".", filesRoot, options);
  } else {
    await copyIndexableExternalFiles(path.dirname(absoluteTarget), path.basename(absoluteTarget), filesRoot, options);
  }

  const importedAt = new Date().toISOString();
  await writeJson(path.join(importRoot, "manifest.json"), {
    original_path: absoluteTarget,
    imported_at: importedAt
  });

  return {
    path: toPosixPath(path.relative(workspace.root, filesRoot)),
    kind: "external_import",
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    no_gitignore: options.noGitignore === true ? true : undefined,
    original_path: absoluteTarget,
    imported_at: importedAt
  };
}

export function normalizeSources(sources: SourceEntry[]): SourceEntry[] {
  const unique = new Map<string, SourceEntry>();
  for (const source of sources) {
    unique.set(normalizeSourcePath(source.path), { ...source, path: normalizeSourcePath(source.path) });
  }

  const sorted = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
  return sorted.filter((candidate) => {
    return !sorted.some((other) => other.path !== candidate.path && canSourceCover(other, candidate));
  });
}

export function coversSource(parent: string, child: string): boolean {
  const normalizedParent = normalizeSourcePath(parent);
  const normalizedChild = normalizeSourcePath(child);
  return normalizedParent === "." || normalizedChild.startsWith(`${normalizedParent}/`);
}

function normalizeSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "" ? "." : normalized;
}

function workspaceSourceFromRelative(relative: string, options: SourcePolicyOptions): SourceEntry {
  return {
    path: relative === "" ? "." : toPosixPath(relative),
    kind: "workspace",
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    no_gitignore: options.noGitignore === true ? true : undefined
  };
}

function canSourceCover(parent: SourceEntry, child: SourceEntry): boolean {
  if (parent.kind !== "workspace" || child.kind !== "workspace") {
    return false;
  }
  return coversSource(parent.path, child.path);
}

async function copyIndexableExternalFiles(
  sourceRoot: string,
  targetRelativePath: string,
  destinationRoot: string,
  options: SourcePolicyOptions
): Promise<void> {
  const files = await listIndexableFileEntries(sourceRoot, targetRelativePath, {
    include: options.include,
    exclude: options.exclude,
    useGitignore: options.noGitignore === true ? false : true
  });

  for (const file of files) {
    const destination = path.join(destinationRoot, file.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file.absolutePath, destination);
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
