import { createId } from "@paralleldrive/cuid2";
import { access, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL_DIM,
  DEFAULT_MODEL_ID,
  type RegistryEntry,
  SCHEMA_VERSION,
  type SourceEntry,
  type WorkspaceConfig,
  type WorkspaceManifest
} from "./types.js";
import { readJson, writeJson } from "./io.js";

export interface Workspace {
  root: string;
  kbxDir: string;
  manifestPath: string;
  configPath: string;
  sourcesPath: string;
  indexPath: string;
}

export const defaultConfig: WorkspaceConfig = {
  chunk: {
    size: 800,
    overlap: 100,
    strategy: "fixed"
  },
  mcp: {
    citations: "safe"
  }
};

export function workspaceFromRoot(root: string): Workspace {
  const resolvedRoot = path.resolve(root);
  const kbxDir = path.join(resolvedRoot, ".kbx");
  return {
    root: resolvedRoot,
    kbxDir,
    manifestPath: path.join(kbxDir, "manifest.json"),
    configPath: path.join(kbxDir, "config.json"),
    sourcesPath: path.join(kbxDir, "sources.json"),
    indexPath: path.join(kbxDir, "index.json")
  };
}

export async function findWorkspace(startDir = process.cwd()): Promise<Workspace | null> {
  let current = path.resolve(startDir);

  while (true) {
    const workspace = workspaceFromRoot(current);
    if (await exists(workspace.kbxDir)) {
      return workspace;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function initWorkspace(root: string): Promise<Workspace> {
  const workspace = workspaceFromRoot(root);
  const now = new Date().toISOString();
  await mkdir(workspace.kbxDir, { recursive: true });

  if (!(await exists(workspace.manifestPath))) {
    const manifest: WorkspaceManifest = {
      workspace_id: createId(),
      name: path.basename(workspace.root),
      model: DEFAULT_MODEL_ID,
      dim: DEFAULT_MODEL_DIM,
      schema_version: SCHEMA_VERSION,
      created_at: now,
      updated_at: now
    };
    await writeJson(workspace.manifestPath, manifest);
  }

  if (!(await exists(workspace.configPath))) {
    await writeJson(workspace.configPath, defaultConfig);
  }

  if (!(await exists(workspace.sourcesPath))) {
    const sources: SourceEntry[] = [];
    await writeJson(workspace.sourcesPath, sources);
  }

  await registerWorkspace(workspace);
  return workspace;
}

export async function loadManifest(workspace: Workspace): Promise<WorkspaceManifest> {
  return readJson<WorkspaceManifest>(workspace.manifestPath);
}

export async function loadConfig(workspace: Workspace): Promise<WorkspaceConfig> {
  return readJson<WorkspaceConfig>(workspace.configPath);
}

export async function loadSources(workspace: Workspace): Promise<SourceEntry[]> {
  if (!(await exists(workspace.sourcesPath))) {
    return [];
  }
  return readJson<SourceEntry[]>(workspace.sourcesPath);
}

export async function saveSources(workspace: Workspace, sources: SourceEntry[]): Promise<void> {
  await writeJson(workspace.sourcesPath, sources);
}

export async function touchManifest(workspace: Workspace): Promise<void> {
  const manifest = await loadManifest(workspace);
  manifest.updated_at = new Date().toISOString();
  await writeJson(workspace.manifestPath, manifest);
}

export function registryPath(): string {
  return path.join(os.homedir(), ".kbx", "registry.json");
}

async function registerWorkspace(workspace: Workspace): Promise<void> {
  const manifest = await loadManifest(workspace);
  const now = new Date().toISOString();
  const registryFile = registryPath();
  const registry = (await exists(registryFile)) ? await readJson<RegistryEntry[]>(registryFile) : [];
  const nextEntry: RegistryEntry = {
    workspace_id: manifest.workspace_id,
    name: manifest.name,
    path: workspace.root,
    created_at: manifest.created_at,
    last_seen_at: now
  };
  const next = registry.filter((entry) => entry.workspace_id !== manifest.workspace_id);
  next.push(nextEntry);
  await writeJson(registryFile, next);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function assertDirectory(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isDirectory()) {
    throw new Error(`${filePath} is not a directory`);
  }
}
