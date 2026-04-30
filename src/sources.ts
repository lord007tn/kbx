import path from "node:path";
import type { SourceEntry } from "./types.js";
import { toPosixPath } from "./io.js";

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
