import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { toPosixPath } from "./io";

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

export async function listIndexableFileEntries(
  workspaceRoot: string,
  targetRelativePath: string,
  options: { includeKbxImports?: boolean; include?: string[]; exclude?: string[]; useGitignore?: boolean } = {}
): Promise<SourceFileEntry[]> {
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

  const gitignore = options.useGitignore === false ? ignore() : await loadGitignore(workspaceRoot);
  const includeMatcher = ignore().add(options.include ?? []);
  const excludeMatcher = ignore().add(options.exclude ?? []);
  const files: SourceFileEntry[] = [];

  for (const entry of entries) {
    const absolutePath = targetInfo.isDirectory() ? path.join(targetPath, entry) : targetPath;
    const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));

    const extension = path.extname(absolutePath).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(extension)) {
      continue;
    }

    const isImport = isKbxImport(relativePath);
    if (isBuiltInExcluded(relativePath, options.includeKbxImports === true) || (!isImport && gitignore.ignores(relativePath))) {
      continue;
    }
    if ((options.include?.length ?? 0) > 0 && !includeMatcher.ignores(relativePath)) {
      continue;
    }
    if (excludeMatcher.ignores(relativePath)) {
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

export async function listIndexableFiles(
  workspaceRoot: string,
  targetRelativePath: string,
  options: { includeKbxImports?: boolean; include?: string[]; exclude?: string[]; useGitignore?: boolean } = {}
): Promise<SourceFile[]> {
  const entries = await listIndexableFileEntries(workspaceRoot, targetRelativePath, options);
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      content: await readFile(entry.absolutePath, "utf8")
    }))
  );
}

function isBuiltInExcluded(relativePath: string, includeKbxImports: boolean): boolean {
  if (includeKbxImports && isKbxImport(relativePath)) {
    return false;
  }
  const matcher = ignore().add(DEFAULT_EXCLUDES);
  return matcher.ignores(relativePath);
}

function isKbxImport(relativePath: string): boolean {
  return relativePath === ".kbx/imports" || relativePath.startsWith(".kbx/imports/");
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
