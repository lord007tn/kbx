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
  ".agents/**",
  ".claude/**",
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
  const targetPathRelativeToWorkspace = toPosixPath(path.relative(workspaceRoot, targetPath));
  const normalizedTargetPath = targetPathRelativeToWorkspace === "" ? "." : targetPathRelativeToWorkspace;
  const gitignore = options.useGitignore === false ? emptyGitignorePolicy() : await loadGitignore(workspaceRoot);
  const globIgnore = globIgnorePatterns([
    ...builtInGlobExcludes(options.includeKbxImports === true),
    ...(options.exclude ?? []),
    ...targetScopedPatterns(normalizedTargetPath, options.exclude ?? [])
  ]);
  const entries = targetInfo.isDirectory()
    ? await fg(globSearchPatterns(normalizedTargetPath, options.include ?? []), {
        absolute: false,
        cwd: workspaceRoot,
        dot: true,
        ignore: globIgnore,
        onlyFiles: true
      })
    : [normalizedTargetPath];

  const includeMatcher = ignore().add(options.include ?? []);
  const includeTargetMatcher = ignore().add(targetScopedPatterns(normalizedTargetPath, options.include ?? []));
  const excludeMatcher = ignore().add(options.exclude ?? []);
  const excludeTargetMatcher = ignore().add(targetScopedPatterns(normalizedTargetPath, options.exclude ?? []));
  const files: SourceFileEntry[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(workspaceRoot, entry);
    const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));
    if (!sourceContainsPath(normalizedTargetPath, relativePath)) {
      continue;
    }

    const extension = path.extname(absolutePath).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(extension)) {
      continue;
    }

    const isImport = isKbxImport(relativePath);
    if (isBuiltInExcluded(relativePath, options.includeKbxImports === true) || (!isImport && gitignore.ignores(relativePath))) {
      continue;
    }
    if ((options.include?.length ?? 0) > 0 && !includeMatcher.ignores(relativePath) && !includeTargetMatcher.ignores(relativePath)) {
      continue;
    }
    if (excludeMatcher.ignores(relativePath) || excludeTargetMatcher.ignores(relativePath)) {
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

  return files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
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

interface GitignorePolicy {
  ignores: (relativePath: string) => boolean;
}

function emptyGitignorePolicy(): GitignorePolicy {
  return {
    ignores: () => false
  };
}

async function loadGitignore(workspaceRoot: string): Promise<GitignorePolicy> {
  const matcher = ignore();
  try {
    const raw = await readFile(path.join(workspaceRoot, ".gitignore"), "utf8");
    matcher.add(raw);
    return {
      ignores: (relativePath) => matcher.ignores(relativePath)
    };
  } catch {
    // A workspace without .gitignore is valid.
    return emptyGitignorePolicy();
  }
}

function globSearchPatterns(targetRelativePath: string, include: string[]): string[] {
  if (include.length > 0) {
    return unique(include.flatMap((pattern) => scopedGlobIncludePatterns(targetRelativePath, pattern)));
  }

  const base = targetRelativePath === "." ? "" : `${targetRelativePath}/`;
  return [`${base}**/*.{${[...INDEXABLE_EXTENSIONS].map((extension) => extension.slice(1)).join(",")}}`];
}

function scopedGlobIncludePatterns(targetRelativePath: string, pattern: string): string[] {
  const normalized = normalizePolicyPattern(pattern);
  if (!normalized || normalized.startsWith("!")) {
    return targetRelativePath === "." ? ["**/*"] : [`${targetRelativePath}/**/*`];
  }

  const workspacePattern = gitignorePatternToGlob(normalized);
  const targetPattern = joinGlob(targetRelativePath, gitignorePatternToGlob(normalized));
  return unique([
    scopeGlobToTarget(workspacePattern, targetRelativePath),
    targetPattern
  ].filter((value): value is string => value !== null));
}

function scopeGlobToTarget(pattern: string, targetRelativePath: string): string | null {
  if (targetRelativePath === ".") {
    return pattern;
  }
  if (pattern === targetRelativePath || pattern.startsWith(`${targetRelativePath}/`)) {
    return pattern;
  }
  if (pattern.startsWith("**/")) {
    return joinGlob(targetRelativePath, pattern);
  }

  const staticPrefix = staticGlobPrefix(pattern);
  if (staticPrefix && targetRelativePath.startsWith(`${staticPrefix}/`)) {
    return `${targetRelativePath}/**/*`;
  }
  if (staticPrefix && staticPrefix.startsWith(`${targetRelativePath}/`)) {
    return pattern;
  }

  return null;
}

function builtInGlobExcludes(includeKbxImports: boolean): string[] {
  if (!includeKbxImports) {
    return DEFAULT_EXCLUDES;
  }
  return DEFAULT_EXCLUDES.filter((pattern) => pattern !== ".kbx/**");
}

function targetScopedPatterns(targetRelativePath: string, patterns: string[]): string[] {
  if (targetRelativePath === ".") {
    return [];
  }
  return patterns
    .map(normalizePolicyPattern)
    .filter((pattern) => pattern && !pattern.startsWith("!"))
    .map((pattern) => joinGlob(targetRelativePath, pattern));
}

function globIgnorePatterns(patterns: string[]): string[] {
  return unique(
    patterns
      .map(normalizePolicyPattern)
      .filter((pattern) => pattern && !pattern.startsWith("!"))
      .map(gitignorePatternToGlob)
  );
}

function gitignorePatternToGlob(pattern: string): string {
  const normalized = normalizePolicyPattern(pattern);
  if (!normalized) {
    return normalized;
  }
  if (normalized.endsWith("/")) {
    const directory = normalized.slice(0, -1);
    return directory.includes("/") ? `${directory}/**` : `**/${directory}/**`;
  }
  return normalized.includes("/") ? normalized : `**/${normalized}`;
}

function normalizePolicyPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return "";
  }
  return trimmed.replaceAll("\\", "/").replace(/^\/+/, "");
}

function joinGlob(parent: string, child: string): string {
  if (parent === ".") {
    return child;
  }
  return `${parent}/${child}`.replace(/\/+/g, "/");
}

function sourceContainsPath(sourcePath: string, filePath: string): boolean {
  return sourcePath === "." || filePath === sourcePath || filePath.startsWith(`${sourcePath}/`);
}

function staticGlobPrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[*?[{]/);
  const staticPart = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  return staticPart.replace(/\/+$/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
