import path from "node:path";
import { refreshWorkspaceFile } from "./indexer";
import { findWorkspace } from "./workspace";

export interface ClaudeCodeHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    edits?: Array<{ file_path?: string }>;
  };
}

export interface FileRefreshHookInput {
  path?: string;
  file_path?: string;
  paths?: string[];
  file_paths?: string[];
  files?: Array<string | { path?: string; file_path?: string }>;
}

export async function handleClaudeCodePostToolUse(rawInput: string): Promise<unknown> {
  const input = parseHookInput(rawInput);
  const filePaths = filePathsFromClaudeTool(input);
  return refreshHookFilePaths(filePaths, "Claude Code edit");
}

export async function handleFileRefreshHook(rawInput: string): Promise<unknown> {
  const input = parseGenericHookInput(rawInput);
  return refreshHookFilePaths(filePathsFromGenericInput(input), "generic edit");
}

async function refreshHookFilePaths(filePaths: string[], label: string): Promise<unknown> {
  if (filePaths.length === 0) {
    return hookContext("kbx hook skipped: no edited file path was present.");
  }

  const workspace = await findWorkspace(process.cwd());
  if (!workspace) {
    return hookContext("kbx hook skipped: no initialized workspace was found.");
  }

  const refreshed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const filePath of filePaths) {
    try {
      await refreshWorkspaceFile(workspace, filePath);
      refreshed.push(toWorkspaceDisplayPath(workspace.root, filePath));
    } catch (error) {
      failed.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const detail = [
    refreshed.length > 0 ? `refreshed ${refreshed.join(", ")}` : "",
    failed.length > 0 ? `failed ${failed.map((entry) => `${entry.path}: ${entry.error}`).join("; ")}` : ""
  ].filter(Boolean).join("; ");
  return hookContext(`kbx index update after ${label}: ${detail || "nothing changed"}.`);
}

function parseHookInput(rawInput: string): ClaudeCodeHookInput {
  if (!rawInput.trim()) {
    return {};
  }
  try {
    return JSON.parse(rawInput) as ClaudeCodeHookInput;
  } catch {
    return {};
  }
}

function parseGenericHookInput(rawInput: string): FileRefreshHookInput {
  if (!rawInput.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawInput) as unknown;
    if (Array.isArray(parsed)) {
      return { paths: parsed.filter((value): value is string => typeof value === "string") };
    }
    return parsed && typeof parsed === "object" ? parsed as FileRefreshHookInput : {};
  } catch {
    return { paths: rawInput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
  }
}

function filePathsFromClaudeTool(input: ClaudeCodeHookInput): string[] {
  const paths = new Set<string>();
  if (input.tool_input?.file_path) {
    paths.add(input.tool_input.file_path);
  }
  for (const edit of input.tool_input?.edits ?? []) {
    if (edit.file_path) {
      paths.add(edit.file_path);
    }
  }
  return [...paths];
}

function filePathsFromGenericInput(input: FileRefreshHookInput): string[] {
  const paths = new Set<string>();
  for (const value of [input.path, input.file_path]) {
    if (value) {
      paths.add(value);
    }
  }
  for (const value of [...(input.paths ?? []), ...(input.file_paths ?? [])]) {
    paths.add(value);
  }
  for (const file of input.files ?? []) {
    if (typeof file === "string") {
      paths.add(file);
    } else if (file.path) {
      paths.add(file.path);
    } else if (file.file_path) {
      paths.add(file.file_path);
    }
  }
  return [...paths];
}

function hookContext(message: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: message
    },
    suppressOutput: true
  };
}

function toWorkspaceDisplayPath(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, filePath)).replaceAll("\\", "/");
  return relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative) ? relative : filePath;
}
