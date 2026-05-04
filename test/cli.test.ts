import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const invalidReranker = await runCliExpectFailure(fixture, ["search", "retrieval citations", "--reranker", "bogus"]);
    assert.equal(invalidReranker.code, 1);
    assert.match(invalidReranker.stderr, /Unknown reranker mode "bogus"/);

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

function cliEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KBX_EMBEDDER: "hash",
    KBX_HOME: fixture.home,
    KBX_MODEL_CACHE: fixture.modelCache,
    ONNXRUNTIME_NODE_INSTALL: process.env.ONNXRUNTIME_NODE_INSTALL ?? "skip"
  };
}
