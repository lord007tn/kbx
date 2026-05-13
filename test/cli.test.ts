import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cliPath = path.resolve("src", "cli.ts");
const tsxLoaderUrl = pathToFileURL(path.resolve("node_modules", "tsx", "dist", "loader.mjs")).href;

test("CLI initializes, ingests, searches, reports stats, and runs doctor", async () => {
  const fixture = await createFixture("kbx-cli-workflow-");
  try {
    await writeFile(path.join(fixture.workspace, "notes.md"), "# Notes\n\nRetrieval citations stay local and searchable.\n", "utf8");

    const init = await runCli(fixture, ["init", "--here", "--model", "minilm"]);
    assert.match(init.stdout, /Initialized/);
    assert.match(init.stdout, /Model: minilm \(384d\)/);

    const ingest = await runCli(fixture, ["ingest"]);
    assert.match(ingest.stdout, /Indexed 1 file\(s\), 1 new chunk\(s\)/);

    const search = await runCli(fixture, ["search", "retrieval citations", "-k", "3"]);
    assert.match(search.stdout, /1\. notes\.md#0/);
    assert.match(search.stdout, /Retrieval citations stay local/);

    const context = await runCli(fixture, ["context", "retrieval citations", "-k", "1"]);
    assert.match(context.stdout, /# kbx context/);
    assert.match(context.stdout, /## notes\.md/);
    assert.match(context.stdout, /Retrieval citations stay local/);

    const invalidReranker = await runCliExpectFailure(fixture, ["search", "retrieval citations", "--reranker", "bogus"]);
    assert.equal(invalidReranker.code, 1);
    assert.match(invalidReranker.stderr, /Unknown reranker mode "bogus"/);

    const status = await runCli(fixture, ["status", "--fresh"]);
    assert.match(status.stdout, /kbx status/);
    assert.match(status.stdout, /Documents:\s+1/);
    assert.match(status.stdout, /Stale:\s+0/);

    const stats = await runCli(fixture, ["stats", "--fresh"]);
    assert.match(stats.stdout, /Documents: 1/);
    assert.match(stats.stdout, /Chunks: 1/);
    assert.match(stats.stdout, /Freshness: 0 stale, 0 deleted, 0 new/);

    const doctor = await runCli(fixture, ["doctor", "--fresh"]);
    assert.match(doctor.stdout, /ok  workspace:/);
    assert.match(doctor.stdout, /ok  lexical:/);
    assert.match(doctor.stdout, /ok  freshness: 0 stale, 0 deleted, 0 new/);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("CLI setup initializes, ingests, and prints MCP config", async () => {
  const fixture = await createFixture("kbx-cli-setup-");
  try {
    await writeFile(path.join(fixture.workspace, "setup.md"), "# Setup\n\nsetup command token\n", "utf8");

    const setup = await runCli(fixture, ["setup", "--here", "--model", "minilm", "--client", "codex"]);
    assert.match(setup.stdout, /Workspace:/);
    assert.match(setup.stdout, /Model: minilm \(384d\)/);
    assert.match(setup.stdout, /Ingest: indexed 1 file\(s\), 1 new chunk\(s\)/);
    assert.match(setup.stdout, /\[mcp_servers\.kbx\]/);

    const context = await runCli(fixture, ["context", "setup command token", "-k", "1"]);
    assert.match(context.stdout, /setup command token/);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("CLI destructive paths require confirmation or explicit --yes", async () => {
  const fixture = await createFixture("kbx-cli-destructive-");
  try {
    await writeFile(path.join(fixture.workspace, "remove-me.md"), "# Remove\n\nTemporary indexed content.\n", "utf8");
    await runCli(fixture, ["init", "--here", "--model", "minilm"]);
    await runCli(fixture, ["ingest"]);

    const blockedReset = await runCliExpectFailure(fixture, ["reset"]);
    assert.equal(blockedReset.code, 1);
    assert.match(blockedReset.stderr, /Confirmation required/);

    const sources = await runCli(fixture, ["sources", "list"]);
    assert.match(sources.stdout, /1\. \. \(workspace\)/);

    const removed = await runCli(fixture, ["sources", "remove", "1", "--yes"]);
    assert.match(removed.stdout, /Removed source \.; deleted chunks for 1 file\(s\)\./);

    const emptySources = await runCli(fixture, ["sources", "list"]);
    assert.match(emptySources.stdout, /No sources\./);

    const reset = await runCli(fixture, ["reset", "--yes"]);
    assert.match(reset.stdout, /Reset workspace index\./);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("CLI rejects positive integer options with trailing junk", async () => {
  const fixture = await createFixture("kbx-cli-integer-options-");
  try {
    await writeFile(path.join(fixture.workspace, "notes.md"), "# Notes\n\nInteger parser token.\n", "utf8");
    await runCli(fixture, ["init", "--here", "--model", "minilm"]);
    await runCli(fixture, ["ingest"]);

    const badTopK = await runCliExpectFailure(fixture, ["search", "integer", "-k", "2abc"]);
    assert.equal(badTopK.code, 1);
    assert.match(badTopK.stderr, /Expected a positive integer/);

    const badMemoryRetention = await runCliExpectFailure(fixture, ["memory", "add", "bad memory", "--retention-days", "30abc"]);
    assert.equal(badMemoryRetention.code, 1);
    assert.match(badMemoryRetention.stderr, /Expected a positive integer/);

    const badConfigValue = await runCliExpectFailure(fixture, ["config", "set", "chunk.size", "1200abc"]);
    assert.equal(badConfigValue.code, 1);
    assert.match(badConfigValue.stderr, /positive integer/);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("CLI labels skipped non-text files without calling them only unchanged", async () => {
  const fixture = await createFixture("kbx-cli-skip-label-");
  try {
    await writeFile(path.join(fixture.workspace, "binary.txt"), Buffer.from([0, 159, 146, 150, 0, 1]));
    await runCli(fixture, ["init", "--here", "--model", "minilm"]);

    const ingest = await runCli(fixture, ["ingest"]);
    assert.match(ingest.stdout, /1 skipped\/unchanged file\(s\)/);
    assert.doesNotMatch(ingest.stdout, /1 unchanged file\(s\)/);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("CLI ingest path watch mode stays scoped to the requested target", async () => {
  const fixture = await createFixture("kbx-cli-watch-target-");
  try {
    await mkdir(path.join(fixture.workspace, "docs"), { recursive: true });
    await writeFile(path.join(fixture.workspace, "root.md"), "# Root\n\nroot watch token\n", "utf8");
    await writeFile(path.join(fixture.workspace, "docs", "note.md"), "# Note\n\ndocs watch token\n", "utf8");
    await runCli(fixture, ["init", "--here", "--model", "minilm"]);
    await runCli(fixture, ["ingest"]);

    const watcher = spawnCli(fixture, ["ingest", "docs", "--watch"]);
    try {
      assert.equal(await waitForOutput(watcher, /Watching 1 path\(s\)/), true);

      await writeFile(path.join(fixture.workspace, "root.md"), "# Root\n\nroot outside watch token\n", "utf8");
      await sleep(1200);
      assert.doesNotMatch(watcher.output(), /Refreshed/);

      await writeFile(path.join(fixture.workspace, "docs", "note.md"), "# Note\n\ndocs inside watch token\n", "utf8");
      assert.equal(await waitForOutput(watcher, /Refreshed/), true);
    } finally {
      await watcher.close();
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test("CLI background watch keeps the index fresh and can be stopped", async () => {
  const fixture = await createFixture("kbx-cli-watch-background-");
  try {
    await writeFile(path.join(fixture.workspace, "note.md"), "# Note\n\ninitial background token\n", "utf8");
    await runCli(fixture, ["init", "--here", "--model", "minilm"]);
    await runCli(fixture, ["ingest"]);

    const started = await runCli(fixture, ["watch", "--background"]);
    assert.match(started.stdout, /Started \(pid \d+\)\./);
    assert.equal(await waitForFileText(path.join(fixture.workspace, ".kbx", "watch.log"), /Watching 1 path\(s\)/), true);

    await writeFile(path.join(fixture.workspace, "note.md"), "# Note\n\nupdated background token\n", "utf8");
    assert.equal(await waitForCliSearch(fixture, "updated background token", /updated background token/), true);

    const stopped = await runCli(fixture, ["watch", "--stop"]);
    assert.match(stopped.stdout, /Stopped background watcher/);
  } finally {
    await runCli(fixture, ["watch", "--stop"]).catch(() => undefined);
    await cleanupFixture(fixture);
  }
});

interface Fixture {
  root: string;
  workspace: string;
  home: string;
  modelCache: string;
}

interface CliResult {
  stdout: string;
  stderr: string;
}

interface CliFailure extends CliResult {
  code: number | string | undefined;
}

async function createFixture(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    home: path.join(root, "home"),
    modelCache: path.join(root, "models")
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

async function runCli(fixture: Fixture, args: string[]): Promise<CliResult> {
  return exec(process.execPath, ["--import", tsxLoaderUrl, cliPath, ...args], {
    cwd: fixture.workspace,
    env: cliEnv(fixture),
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function runCliExpectFailure(fixture: Fixture, args: string[]): Promise<CliFailure> {
  try {
    const result = await runCli(fixture, args);
    assert.fail(`Expected kbx ${args.join(" ")} to fail, but it succeeded with: ${result.stdout}`);
  } catch (error) {
    const failure = error as Partial<CliFailure>;
    return {
      code: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? ""
    };
  }
}

function spawnCli(fixture: Fixture, args: string[]) {
  const child = spawn(process.execPath, ["--import", tsxLoaderUrl, cliPath, ...args], {
    cwd: fixture.workspace,
    env: cliEnv(fixture),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  return {
    output: () => output,
    close: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        sleep(3000)
      ]);
    }
  };
}

async function waitForOutput(watcher: { output: () => string }, pattern: RegExp, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(watcher.output())) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function waitForCliSearch(fixture: Fixture, query: string, pattern: RegExp, timeoutMs = 10000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await runCli(fixture, ["search", query, "-k", "1"]);
    if (pattern.test(result.stdout)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForFileText(filePath: string, pattern: RegExp, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const content = await readFile(filePath, "utf8");
      if (pattern.test(content)) {
        return true;
      }
    } catch {
      // The background watcher creates its log after the child process starts.
    }
    await sleep(100);
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cliEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KBX_EMBEDDER: "hash",
    KBX_HOME: fixture.home,
    KBX_MODEL_CACHE: fixture.modelCache,
    ONNXRUNTIME_NODE_INSTALL: process.env.ONNXRUNTIME_NODE_INSTALL ?? "skip"
  };
}
