import { createId } from "@paralleldrive/cuid2";
import { access, mkdir, rm, stat } from "node:fs/promises";
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
  statsPath: string;
  collectionDir: string;
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
    statsPath: path.join(kbxDir, "stats.json"),
    collectionDir: path.join(kbxDir, "collection")
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

export async function loadRegistry(): Promise<RegistryEntry[]> {
  const registryFile = registryPath();
  if (!(await exists(registryFile))) {
    return [];
  }
  return readJson<RegistryEntry[]>(registryFile);
}

export async function saveRegistry(registry: RegistryEntry[]): Promise<void> {
  await writeJson(registryPath(), registry);
}

export async function forgetWorkspace(selector: string): Promise<RegistryEntry> {
  const registry = await loadRegistry();
  const selected = resolveWorkspaceSelector(registry, selector);
  await saveRegistry(registry.filter((entry) => entry.workspace_id !== selected.workspace_id));
  return selected;
}

export async function deleteWorkspaceKnowledgeBase(selector: string): Promise<RegistryEntry> {
  const selected = await forgetWorkspace(selector);
  await rm(path.join(selected.path, ".kbx"), { recursive: true, force: true });
  return selected;
}

export function resolveWorkspaceSelector(registry: RegistryEntry[], selector: string): RegistryEntry {
  const resolvedPath = path.resolve(selector);
  const byPath = registry.filter((entry) => path.resolve(entry.path) === resolvedPath);
  if (byPath.length === 1) {
    return byPath[0]!;
  }

  const byId = registry.filter((entry) => entry.workspace_id === selector || entry.workspace_id.startsWith(selector));
  if (byId.length === 1) {
    return byId[0]!;
  }
  if (byId.length > 1) {
    throw new Error(`Workspace selector "${selector}" matches multiple workspace IDs. Use a longer ID.`);
  }

  const byName = registry.filter((entry) => entry.name === selector);
  if (byName.length === 1) {
    return byName[0]!;
  }
  if (byName.length > 1) {
    throw new Error(`Workspace name "${selector}" is ambiguous. Use workspace ID or path.`);
  }

  throw new Error(`No registered workspace matches "${selector}".`);
}

async function registerWorkspace(workspace: Workspace): Promise<void> {
  const manifest = await loadManifest(workspace);
  const now = new Date().toISOString();
  const registry = await loadRegistry();
  const nextEntry: RegistryEntry = {
    workspace_id: manifest.workspace_id,
    name: manifest.name,
    path: workspace.root,
    created_at: manifest.created_at,
    last_seen_at: now
  };
  const next = registry.filter((entry) => entry.workspace_id !== manifest.workspace_id);
  next.push(nextEntry);
  await saveRegistry(next);
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
