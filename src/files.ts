import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { toPosixPath } from "./io.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
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
  mtime: number;
  content: string;
}

export async function listMarkdownFiles(workspaceRoot: string, targetRelativePath: string): Promise<SourceFile[]> {
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
  const files: SourceFile[] = [];

  for (const entry of entries) {
    const absolutePath = targetInfo.isDirectory() ? path.join(targetPath, entry) : targetPath;
    const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));

    if (!MARKDOWN_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
      continue;
    }

    if (isBuiltInExcluded(relativePath) || gitignore.ignores(relativePath)) {
      continue;
    }

    const [fileInfo, content] = await Promise.all([stat(absolutePath), readFile(absolutePath, "utf8")]);
    files.push({
      absolutePath,
      relativePath,
      mtime: Math.floor(fileInfo.mtimeMs),
      content
    });
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function isBuiltInExcluded(relativePath: string): boolean {
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
