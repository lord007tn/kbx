import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { toPosixPath } from "./io.js";

const INDEXABLE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".html",
  ".css",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml"
]);
const DEFAULT_EXCLUDES = [
  ".git/**",
  ".kbx/**",
  "node_modules/**",
  "vendor/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".turbo/**",
  "coverage/**"
];

export interface SourceFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  mtime: number;
  content: string;
}

export interface SourceFileEntry {
  absolutePath: string;
  relativePath: string;
  extension: string;
  mtime: number;
}

export async function listIndexableFileEntries(workspaceRoot: string, targetRelativePath: string): Promise<SourceFileEntry[]> {
  const targetPath = path.resolve(workspaceRoot, targetRelativePath);
  const targetInfo = await stat(targetPath);
  const entries = targetInfo.isDirectory()
    ? await fg("**/*", {
        absolute: false,
        cwd: targetPath,
        dot: true,
        onlyFiles: true
      })
    : [path.basename(targetPath)];

  const gitignore = await loadGitignore(workspaceRoot);
  const files: SourceFileEntry[] = [];

  for (const entry of entries) {
    const absolutePath = targetInfo.isDirectory() ? path.join(targetPath, entry) : targetPath;
    const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));

    const extension = path.extname(absolutePath).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(extension)) {
      continue;
    }

    if (isBuiltInExcluded(relativePath) || gitignore.ignores(relativePath)) {
      continue;
    }

    const fileInfo = await stat(absolutePath);
    files.push({
      absolutePath,
      relativePath,
      extension,
      mtime: Math.floor(fileInfo.mtimeMs)
    });
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function listIndexableFiles(workspaceRoot: string, targetRelativePath: string): Promise<SourceFile[]> {
  const entries = await listIndexableFileEntries(workspaceRoot, targetRelativePath);
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      content: await readFile(entry.absolutePath, "utf8")
    }))
  );
}

function isBuiltInExcluded(relativePath: string): boolean {
  if (relativePath.startsWith(".kbx/imports/")) {
    return false;
  }
  const matcher = ignore().add(DEFAULT_EXCLUDES);
  return matcher.ignores(relativePath);
}

async function loadGitignore(workspaceRoot: string): Promise<ReturnType<typeof ignore>> {
  const matcher = ignore();
  try {
    const raw = await readFile(path.join(workspaceRoot, ".gitignore"), "utf8");
    matcher.add(raw);
  } catch {
    // A workspace without .gitignore is valid.
  }
  return matcher;
}
