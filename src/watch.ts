import chokidar from "chokidar";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ingestSource, ingestWorkspaceTarget } from "./indexer";
import { loadSources, type Workspace } from "./workspace";

export interface WatchStatus {
  auto: "disabled" | "enabled";
  running: boolean;
  pid: number | null;
  pid_file: string;
  log_file: string;
}

export interface StartBackgroundWatchResult {
  started: boolean;
  pid: number;
  log_file: string;
}

export async function watchIngest(workspace: Workspace, target?: string, options: { daemon?: boolean } = {}): Promise<void> {
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

  if (options.daemon === true) {
    await writeWatchPid(workspace, process.pid);
  }

  try {
    await new Promise<void>((resolve) => {
      const close = () => {
        void watcher.close().finally(resolve);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
  } finally {
    if (options.daemon === true) {
      await clearWatchPid(workspace, process.pid);
    }
  }
}

export async function startBackgroundWatch(workspace: Workspace, target?: string): Promise<StartBackgroundWatchResult> {
  const existingPid = await readWatchPid(workspace);
  if (existingPid !== null && isProcessRunning(existingPid)) {
    return {
      started: false,
      pid: existingPid,
      log_file: watchLogPath(workspace)
    };
  }

  if (existingPid !== null) {
    await clearWatchPid(workspace, existingPid);
  }

  await mkdir(workspace.kbxDir, { recursive: true });
  const logFile = watchLogPath(workspace);
  const logFd = openSync(logFile, "a");
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    closeSync(logFd);
    throw new Error("Cannot start background watcher because the kbx entrypoint is unknown.");
  }

  const args = [...process.execArgv, entrypoint, "watch", "--daemon"];
  if (target) {
    args.push(target);
  }

  const child = spawn(process.execPath, args, {
    cwd: workspace.root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: process.env
  });
  closeSync(logFd);

  if (!child.pid) {
    throw new Error("Failed to start background watcher.");
  }

  await writeWatchPid(workspace, child.pid);
  child.unref();
  return {
    started: true,
    pid: child.pid,
    log_file: logFile
  };
}

export async function stopBackgroundWatch(workspace: Workspace): Promise<{ stopped: boolean; pid: number | null }> {
  const pid = await readWatchPid(workspace);
  if (pid === null) {
    return { stopped: false, pid: null };
  }

  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // If the process exits between the liveness check and kill, clearing the pid file is still correct.
    }
  }
  await clearWatchPid(workspace, pid);
  return { stopped: true, pid };
}

export async function watchStatus(workspace: Workspace, auto: "disabled" | "enabled"): Promise<WatchStatus> {
  const pid = await readWatchPid(workspace);
  const running = pid !== null && isProcessRunning(pid);
  if (pid !== null && !running) {
    await clearWatchPid(workspace, pid);
  }
  return {
    auto,
    running,
    pid: running ? pid : null,
    pid_file: watchPidPath(workspace),
    log_file: watchLogPath(workspace)
  };
}

async function runRefresh(workspace: Workspace, target: string | undefined, watchTargets: string[]): Promise<void> {
  try {
    if (target) {
      const result = await ingestWorkspaceTarget(workspace, target);
      console.log(`Refreshed ${result.files} file(s), ${result.chunks} new chunk(s), ${result.skipped} skipped/unchanged file(s), ${result.deleted} deleted file(s).`);
      return;
    }

    const sources = await loadSources(workspace);
    for (const source of sources.length > 0 ? sources : [{ path: ".", kind: "workspace" as const, include: [], exclude: [] }]) {
      const result = await ingestSource(workspace, source);
      console.log(`Refreshed ${result.files} file(s), ${result.chunks} new chunk(s), ${result.skipped} skipped/unchanged file(s), ${result.deleted} deleted file(s).`);
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

function watchPidPath(workspace: Workspace): string {
  return path.join(workspace.kbxDir, "watch.pid");
}

function watchLogPath(workspace: Workspace): string {
  return path.join(workspace.kbxDir, "watch.log");
}

async function readWatchPid(workspace: Workspace): Promise<number | null> {
  try {
    const raw = await readFile(watchPidPath(workspace), "utf8");
    const pid = Number(raw.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function writeWatchPid(workspace: Workspace, pid: number): Promise<void> {
  await writeFile(watchPidPath(workspace), `${pid}\n`, "utf8");
}

async function clearWatchPid(workspace: Workspace, expectedPid: number): Promise<void> {
  const current = await readWatchPid(workspace);
  if (current === null || current === expectedPid) {
    await rm(watchPidPath(workspace), { force: true });
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
