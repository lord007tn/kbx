import path from "node:path";
import crypto from "node:crypto";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { writeJson } from "./io.js";
import type { SourceEntry } from "./types.js";
import { toPosixPath } from "./io.js";
import type { Workspace } from "./workspace.js";

export function sourceForTarget(workspaceRoot: string, target: string): SourceEntry {
  const relative = path.relative(workspaceRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("v0.1 only supports ingesting paths inside the initialized workspace");
  }

  return {
    path: relative === "" ? "." : toPosixPath(relative),
    kind: "workspace",
    include: [],
    exclude: []
  };
}

export async function sourceForIngestTarget(workspace: Workspace, target: string, allowExternal: boolean): Promise<SourceEntry> {
  const relative = path.relative(workspace.root, target);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return sourceForTarget(workspace.root, target);
  }

  if (!allowExternal) {
    throw new Error("External paths require --allow-external");
  }

  const absoluteTarget = path.resolve(target);
  const hash = crypto.createHash("sha256").update(absoluteTarget).digest("hex").slice(0, 16);
  const importRoot = path.join(workspace.kbxDir, "imports", hash);
  const filesRoot = path.join(importRoot, "files");
  await rm(importRoot, { recursive: true, force: true });
  await mkdir(filesRoot, { recursive: true });

  const targetInfo = await stat(absoluteTarget);
  if (targetInfo.isDirectory()) {
    await cp(absoluteTarget, filesRoot, { recursive: true, force: true });
  } else {
    await cp(absoluteTarget, path.join(filesRoot, path.basename(absoluteTarget)), { force: true });
  }

  const importedAt = new Date().toISOString();
  await writeJson(path.join(importRoot, "manifest.json"), {
    original_path: absoluteTarget,
    imported_at: importedAt
  });

  return {
    path: toPosixPath(path.relative(workspace.root, filesRoot)),
    kind: "external_import",
    include: [],
    exclude: [],
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
    return !sorted.some((other) => other.path !== candidate.path && coversSource(other.path, candidate.path));
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
