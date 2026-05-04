import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { extractIndexableText } from "./document-text";
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
  ".xml",
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".epub",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".bmp"
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
  "coverage/**",
  "*.gen.*",
  "*.generated.*",
  "*.pb.go",
  "*.pb.ts",
  "auto-imports.d.ts",
  "cloudflare-env.d.ts",
  "components.d.ts",
  "typed-router.d.ts",
  "worker-configuration.d.ts",
  "**/icons/demo.html",
  "**/icons/fonts/icomoon.svg",
  "**/icons/selection.json",
  "**/icons/style.css",
  "**/prisma/migrations/migration_lock.toml",
  ".env",
  ".env.*",
  "*.env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.crt",
  "*.cer",
  "*.der",
  "*.kdbx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*_rsa",
  "*_dsa",
  "*_ecdsa",
  "*_ed25519",
  "secrets/**",
  ".secrets/**",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum"
];
const FILE_STAT_CONCURRENCY = 64;

export interface SourceFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  mtime: number;
  size: number;
  content: string;
}

export interface SourceFileEntry {
  absolutePath: string;
  relativePath: string;
  extension: string;
  mtime: number;
  size: number;
}

export async function listIndexableFileEntries(
  workspaceRoot: string,
  targetRelativePath: string,
  options: { includeKbxImports?: boolean; includeKbxSessions?: boolean; include?: string[]; exclude?: string[]; useGitignore?: boolean } = {}
): Promise<SourceFileEntry[]> {
  const targetPath = path.resolve(workspaceRoot, targetRelativePath);
  const targetInfo = await stat(targetPath);
  const workspaceRealRoot = await realpath(workspaceRoot);
  const targetPathRelativeToWorkspace = toPosixPath(path.relative(workspaceRoot, targetPath));
  const normalizedTargetPath = targetPathRelativeToWorkspace === "" ? "." : targetPathRelativeToWorkspace;
  const gitignore = options.useGitignore === false ? emptyGitignorePolicy() : await loadGitignore(workspaceRoot);
  const globIgnore = globIgnorePatterns([
    ...builtInGlobExcludes(managedKbxOptions(options)),
    ...safeGitignoreGlobExcludes(hasManagedKbxAccess(options) ? [] : gitignore.patterns),
    ...(options.exclude ?? []),
    ...targetScopedPatterns(normalizedTargetPath, options.exclude ?? [])
  ]);
  const entries = targetInfo.isDirectory()
    ? await fg(globSearchPatterns(normalizedTargetPath, options.include ?? []), {
        absolute: false,
        cwd: workspaceRoot,
        dot: true,
        ignore: globIgnore,
        onlyFiles: true,
        followSymbolicLinks: false
      })
    : [normalizedTargetPath];

  const includeMatcher = ignore().add(options.include ?? []);
  const includeTargetMatcher = ignore().add(targetScopedPatterns(normalizedTargetPath, options.include ?? []));
  const excludeMatcher = ignore().add(options.exclude ?? []);
  const excludeTargetMatcher = ignore().add(targetScopedPatterns(normalizedTargetPath, options.exclude ?? []));
  const files = await mapConcurrent(entries, FILE_STAT_CONCURRENCY, async (entry): Promise<SourceFileEntry | null> => {
    const absolutePath = path.join(workspaceRoot, entry);
    const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));
    if (!sourceContainsPath(normalizedTargetPath, relativePath)) {
      return null;
    }

    const extension = path.extname(absolutePath).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(extension)) {
      return null;
    }

    const isManagedKbx = isKbxImport(relativePath) || isKbxSession(relativePath);
    if (isBuiltInExcluded(relativePath, managedKbxOptions(options)) || (!isManagedKbx && gitignore.ignores(relativePath))) {
      return null;
    }
    if ((options.include?.length ?? 0) > 0 && !includeMatcher.ignores(relativePath) && !includeTargetMatcher.ignores(relativePath)) {
      return null;
    }
    if (excludeMatcher.ignores(relativePath) || excludeTargetMatcher.ignores(relativePath)) {
      return null;
    }

    let fileInfo;
    let realAbsolutePath;
    try {
      realAbsolutePath = await realpath(absolutePath);
      if (!isPathInside(workspaceRealRoot, realAbsolutePath)) {
        return null;
      }
      fileInfo = await stat(realAbsolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }

    return {
      absolutePath: realAbsolutePath,
      relativePath,
      extension,
      mtime: Math.floor(fileInfo.mtimeMs),
      size: fileInfo.size
    };
  });

  return files
    .filter((file): file is SourceFileEntry => file !== null)
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
}

export async function listIndexableFiles(
  workspaceRoot: string,
  targetRelativePath: string,
  options: { includeKbxImports?: boolean; includeKbxSessions?: boolean; include?: string[]; exclude?: string[]; useGitignore?: boolean } = {}
): Promise<SourceFile[]> {
  const entries = await listIndexableFileEntries(workspaceRoot, targetRelativePath, options);
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      content: await extractIndexableText(entry.absolutePath, entry.extension)
    }))
  );
}

function isBuiltInExcluded(relativePath: string, options: ManagedKbxOptions): boolean {
  if (options.includeKbxImports && isKbxImport(relativePath)) {
    return false;
  }
  if (options.includeKbxSessions && isKbxSession(relativePath)) {
    return false;
  }
  const matcher = ignore().add(DEFAULT_EXCLUDES);
  return matcher.ignores(relativePath);
}

function isKbxImport(relativePath: string): boolean {
  return relativePath === ".kbx/imports" || relativePath.startsWith(".kbx/imports/");
}

function isKbxSession(relativePath: string): boolean {
  return relativePath === ".kbx/sessions" || relativePath.startsWith(".kbx/sessions/");
}

interface ManagedKbxOptions {
  includeKbxImports: boolean;
  includeKbxSessions: boolean;
}

function managedKbxOptions(options: { includeKbxImports?: boolean; includeKbxSessions?: boolean }): ManagedKbxOptions {
  return {
    includeKbxImports: options.includeKbxImports === true,
    includeKbxSessions: options.includeKbxSessions === true
  };
}

function hasManagedKbxAccess(options: { includeKbxImports?: boolean; includeKbxSessions?: boolean }): boolean {
  return options.includeKbxImports === true || options.includeKbxSessions === true;
}

interface GitignorePolicy {
  ignores: (relativePath: string) => boolean;
  patterns: string[];
}

interface IgnoreRuleSet {
  baseRelativePath: string;
  matcher: ReturnType<typeof ignore>;
}

function emptyGitignorePolicy(): GitignorePolicy {
  return {
    ignores: () => false,
    patterns: []
  };
}

async function loadGitignore(workspaceRoot: string): Promise<GitignorePolicy> {
  const ruleSets: IgnoreRuleSet[] = [];
  const patterns: string[] = [];

  const addIgnoreFile = async (fileName: string, includeInFastGlobPatterns: boolean) => {
    try {
      const raw = await readFile(path.join(workspaceRoot, fileName), "utf8");
      const matcher = ignore().add(raw);
      const baseRelativePath = toPosixPath(path.dirname(fileName));
      ruleSets.push({
        baseRelativePath: baseRelativePath === "." ? "." : baseRelativePath,
        matcher
      });
      if (includeInFastGlobPatterns) {
        patterns.push(...raw.split(/\r?\n/));
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  };

  const gitignoreFiles = await fg("**/.gitignore", {
    absolute: false,
    cwd: workspaceRoot,
    dot: true,
    ignore: globIgnorePatterns(builtInGlobExcludes({ includeKbxImports: false, includeKbxSessions: false })),
    onlyFiles: true,
    followSymbolicLinks: false
  });
  for (const fileName of gitignoreFiles.sort()) {
    await addIgnoreFile(fileName, fileName === ".gitignore");
  }
  await addIgnoreFile(".kbxignore", true);

  return {
    ignores: (relativePath) => ignoredByRuleSets(ruleSets, relativePath),
    patterns
  };
}

function ignoredByRuleSets(ruleSets: IgnoreRuleSet[], relativePath: string): boolean {
  let ignored = false;
  for (const ruleSet of ruleSets) {
    const candidate = ruleSet.baseRelativePath === "."
      ? relativePath
      : relativePath.startsWith(`${ruleSet.baseRelativePath}/`)
        ? relativePath.slice(ruleSet.baseRelativePath.length + 1)
        : null;
    if (!candidate) {
      continue;
    }

    const result = ruleSet.matcher.test(candidate);
    if (result.ignored) {
      ignored = true;
    }
    if (result.unignored) {
      ignored = false;
    }
  }
  return ignored;
}

function safeGitignoreGlobExcludes(patterns: string[]): string[] {
  const normalized = patterns.map(normalizePolicyPattern).filter(Boolean);
  const safe: string[] = [];
  for (const [index, pattern] of normalized.entries()) {
    if (pattern.startsWith("!")) {
      continue;
    }
    const hasLaterNegation = normalized.slice(index + 1).some((candidate) => candidate.startsWith("!"));
    if (!hasLaterNegation) {
      safe.push(pattern);
    }
  }
  return safe;
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

  const workspacePattern = gitignorePatternToGlobs(normalized)[0] ?? "";
  const targetPattern = joinGlob(targetRelativePath, workspacePattern);
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

function builtInGlobExcludes(options: ManagedKbxOptions): string[] {
  if (!options.includeKbxImports && !options.includeKbxSessions) {
    return DEFAULT_EXCLUDES;
  }
  return DEFAULT_EXCLUDES.filter((pattern) => {
    if (pattern !== ".kbx/**") {
      return true;
    }
    return false;
  });
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
      .flatMap(gitignorePatternToGlobs)
  );
}

function gitignorePatternToGlobs(pattern: string): string[] {
  const normalized = normalizePolicyPattern(pattern);
  if (!normalized) {
    return [];
  }
  if (normalized.endsWith("/")) {
    const directory = normalized.slice(0, -1);
    return directory.includes("/") ? [`${directory}/**`] : [`${directory}/**`, `**/${directory}/**`];
  }
  if (normalized.endsWith("/**")) {
    const directory = normalized.slice(0, -3);
    return directory.includes("/") ? [normalized] : [normalized, `**/${normalized}`];
  }
  return normalized.includes("/")
    ? [normalized, `${normalized}/**`]
    : [`**/${normalized}`, `**/${normalized}/**`];
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

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
