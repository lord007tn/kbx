import { createId } from "@paralleldrive/cuid2";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL_DIM,
  DEFAULT_MODEL_ID,
  type RegistryEntry,
  SCHEMA_VERSION,
  type SourceEntry,
  type UserConfig,
  type WorkspaceConfig,
  type WorkspaceManifest
} from "./types";
import { readJson, writeJson } from "./io";

export interface Workspace {
  root: string;
  kbxDir: string;
  manifestPath: string;
  configPath: string;
  sourcesPath: string;
  statsPath: string;
  lexicalPath: string;
  sessionPath: string;
  graphPath: string;
  collectionDir: string;
}

export const defaultConfig: WorkspaceConfig = {
  chunk: {
    size: 800,
    overlap: 100,
    strategy: "heading"
  },
  mcp: {
    citations: "safe",
    destructive_tools: "disabled"
  },
  sessions: {
    capture: "disabled",
    retention_days: 30,
    max_event_bytes: 16000,
    index_events: "disabled"
  },
  graph: {
    enabled: "disabled",
    max_chunks: 20000
  },
  watch: {
    auto: "disabled"
  }
};

export const defaultUserConfig: UserConfig = {
  init: {
    root_preference: "current"
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
    lexicalPath: path.join(kbxDir, "lexical.db"),
    sessionPath: path.join(kbxDir, "sessions.db"),
    graphPath: path.join(kbxDir, "graph.db"),
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

export interface InitWorkspaceOptions {
  model?: string;
  dim?: number;
}

export async function initWorkspace(root: string, options: InitWorkspaceOptions = {}): Promise<Workspace> {
  const workspace = workspaceFromRoot(root);
  const now = new Date().toISOString();
  await mkdir(workspace.kbxDir, { recursive: true });
  const model = options.model ?? DEFAULT_MODEL_ID;
  const dim = options.dim ?? DEFAULT_MODEL_DIM;

  if (!(await exists(workspace.manifestPath))) {
    const manifest: WorkspaceManifest = {
      workspace_id: createId(),
      name: path.basename(workspace.root),
      model,
      dim,
      schema_version: SCHEMA_VERSION,
      created_at: now,
      updated_at: now
    };
    await writeJson(workspace.manifestPath, manifest);
  } else if (options.model || options.dim) {
    const manifest = await loadManifest(workspace);
    if (manifest.model !== model || manifest.dim !== dim) {
      throw new Error("Workspace is already initialized with a different model. Use kbx model use to switch models.");
    }
  }

  if (!(await exists(workspace.configPath))) {
    await writeJson(workspace.configPath, defaultConfig);
  }

  if (!(await exists(workspace.sourcesPath))) {
    const sources: SourceEntry[] = [];
    await writeJson(workspace.sourcesPath, sources);
  }

  await ignoreKbxInGit(workspace.root);
  await registerWorkspace(workspace);
  return workspace;
}

export async function loadManifest(workspace: Workspace): Promise<WorkspaceManifest> {
  return readJson<WorkspaceManifest>(workspace.manifestPath);
}

export async function saveManifest(workspace: Workspace, manifest: WorkspaceManifest): Promise<void> {
  await writeJson(workspace.manifestPath, manifest);
}

export async function loadConfig(workspace: Workspace): Promise<WorkspaceConfig> {
  const stored = await readJson<Partial<WorkspaceConfig>>(workspace.configPath);
  return {
    ...defaultConfig,
    ...stored,
    chunk: {
      ...defaultConfig.chunk,
      ...stored.chunk
    },
    mcp: {
      ...defaultConfig.mcp,
      ...stored.mcp
    },
    sessions: {
      ...defaultConfig.sessions,
      ...stored.sessions
    },
    graph: {
      ...defaultConfig.graph,
      ...stored.graph
    },
    watch: {
      ...defaultConfig.watch,
      ...stored.watch
    }
  };
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

export async function saveConfig(workspace: Workspace, config: WorkspaceConfig): Promise<void> {
  await writeJson(workspace.configPath, config);
}

export function userKbxDir(): string {
  return process.env.KBX_HOME ? path.resolve(process.env.KBX_HOME) : path.join(os.homedir(), ".kbx");
}

export function userConfigPath(): string {
  return path.join(userKbxDir(), "config.json");
}

export async function loadUserConfig(): Promise<UserConfig> {
  const configFile = userConfigPath();
  if (!(await exists(configFile))) {
    return structuredClone(defaultUserConfig);
  }
  const stored = await readJson<Partial<UserConfig>>(configFile);
  return {
    ...defaultUserConfig,
    ...stored,
    init: {
      ...defaultUserConfig.init,
      ...stored.init
    }
  };
}

export async function saveUserConfig(config: UserConfig): Promise<void> {
  await writeJson(userConfigPath(), config);
}

export async function touchManifest(workspace: Workspace): Promise<void> {
  const manifest = await loadManifest(workspace);
  manifest.updated_at = new Date().toISOString();
  await writeJson(workspace.manifestPath, manifest);
}

export function registryPath(): string {
  return path.join(userKbxDir(), "registry.json");
}

export async function loadRegistry(): Promise<RegistryEntry[]> {
  const registryFile = registryPath();
  if (!(await exists(registryFile))) {
    return [];
  }
  const registry = await readJson<RegistryEntry[] | RegistryEntry>(registryFile);
  if (Array.isArray(registry)) {
    return registry;
  }
  return isRegistryEntry(registry) ? [registry] : [];
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

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RegistryEntry>;
  return typeof candidate.workspace_id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.path === "string"
    && typeof candidate.created_at === "string"
    && typeof candidate.last_seen_at === "string";
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

export async function findGitRoot(startDir = process.cwd()): Promise<string | null> {
  let current = path.resolve(startDir);

  while (true) {
    if (await exists(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function ignoreKbxInGit(root: string): Promise<void> {
  if (!(await exists(path.join(root, ".git")))) {
    return;
  }

  const gitignorePath = path.join(root, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch {
    // A git repository without .gitignore is valid.
  }

  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".kbx/") || lines.includes(".kbx")) {
    return;
  }

  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${prefix}.kbx/\n`, "utf8");
}
