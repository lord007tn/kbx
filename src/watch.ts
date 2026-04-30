import chokidar from "chokidar";
import path from "node:path";
import { ingestWorkspaceTarget } from "./indexer.js";
import { loadSources, type Workspace } from "./workspace.js";

export async function watchIngest(workspace: Workspace, target?: string): Promise<void> {
  const watchTargets = target ? [target] : await sourceWatchTargets(workspace);
  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    ignored: [
      /(^|[\\/])\.git([\\/]|$)/,
      /(^|[\\/])node_modules([\\/]|$)/,
      /(^|[\\/])dist([\\/]|$)/,
      /(^|[\\/])build([\\/]|$)/,
      /(^|[\\/])coverage([\\/]|$)/,
      /(^|[\\/])\.next([\\/]|$)/,
      /(^|[\\/])\.turbo([\\/]|$)/,
      /(^|[\\/])\.kbx(?![\\/]imports)([\\/]|$)/
    ]
  });

  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void runRefresh(workspace, target, watchTargets);
    }, 150);
  };

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  watcher.on("error", (error) => {
    console.error(`Watch error: ${error instanceof Error ? error.message : String(error)}`);
  });

  console.log(`Watching ${watchTargets.length} path(s). Press Ctrl+C to stop.`);

  await new Promise<void>((resolve) => {
    const close = () => {
      void watcher.close().finally(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

async function runRefresh(workspace: Workspace, target: string | undefined, watchTargets: string[]): Promise<void> {
  try {
    const targets = target ? [target] : watchTargets;
    for (const item of targets) {
      const result = await ingestWorkspaceTarget(workspace, item);
      console.log(`Refreshed ${result.files} file(s), ${result.chunks} new chunk(s), ${result.skipped} unchanged file(s), ${result.deleted} deleted file(s).`);
    }
  } catch (error) {
    console.error(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function sourceWatchTargets(workspace: Workspace): Promise<string[]> {
  const sources = await loadSources(workspace);
  if (sources.length === 0) {
    return [workspace.root];
  }
  return sources.map((source) => path.resolve(workspace.root, source.path));
}
