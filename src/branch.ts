import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { IndexedFileStats, SourceEntry } from "./types";
import type { Workspace } from "./workspace";

const exec = promisify(execFile);

export interface BranchContext {
  scope: string;
  name: string;
  head: string;
  gitRoot: string;
}

export async function branchContextForSource(workspace: Workspace, source: SourceEntry): Promise<BranchContext | null> {
  if (source.kind !== "workspace") {
    return null;
  }
  return currentBranchContext(workspace.root);
}

export async function currentBranchContext(workspaceRoot: string): Promise<BranchContext | null> {
  try {
    const gitRoot = normalizePath((await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim());
    const head = (await runGit(workspaceRoot, ["rev-parse", "--short=12", "HEAD"])).trim();
    const branch = (await runGit(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const name = branch === "HEAD" ? `detached:${head}` : branch;
    return {
      scope: branch === "HEAD" ? `detached:${head}` : `branch:${branch}`,
      name,
      head,
      gitRoot
    };
  } catch {
    return null;
  }
}

export function sourceKeyForPath(relativePath: string, branch: BranchContext | null): string {
  if (!branch) {
    return relativePath;
  }
  return `git:${encodeURIComponent(branch.scope)}:${relativePath}`;
}

export function indexedRelativePath(key: string, stats: IndexedFileStats): string {
  return stats.relative_path ?? legacyRelativePath(key);
}

export function isIndexedInBranch(stats: IndexedFileStats, branchScope: string | undefined): boolean {
  if (!branchScope) {
    return stats.branch_scope === undefined;
  }
  return stats.branch_scope === branchScope;
}

export function branchIndexExists(files: Record<string, IndexedFileStats>, branchScope: string | undefined): boolean {
  return branchScope !== undefined && Object.values(files).some((file) => file.branch_scope === branchScope);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

function legacyRelativePath(key: string): string {
  const match = key.match(/^git:[^:]+:(.+)$/);
  return match?.[1] ?? key;
}

function normalizePath(value: string): string {
  return path.resolve(value);
}
