import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleSessionCaptureHook } from "../src/hooks";
import { writeJson } from "../src/io";
import {
  addSessionCheckpoint,
  appendSessionEvent,
  applySessionRewind,
  endSession,
  listSessionEvents,
  previewSessionRewind,
  searchRegisteredSessions,
  searchSessions,
  sessionTimeline,
  startSession
} from "../src/session-store";
import { SCHEMA_VERSION, type RegistryEntry, type WorkspaceConfig, type WorkspaceManifest } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

test("session store captures redacted full events and replay checkpoints", async () => {
  const fixture = await createSessionWorkspace("kbx-session-full-", {
    ...defaultConfig,
    sessions: {
      ...defaultConfig.sessions,
      capture: "full"
    }
  });
  try {
    const session = await startSession(fixture.workspace, {
      name: "Implementation",
      client: "codex"
    });
    const event = await appendSessionEvent(fixture.workspace, {
      sessionId: session.id,
      type: "tool",
      toolName: "shell",
      summary: "Ran command with secret",
      input: { command: "curl", api_key: "sk-test-secret-token-1234567890" },
      output: "ok"
    });
    const checkpoint = await addSessionCheckpoint(fixture.workspace, session.id, "after-redaction", "verified event redaction");
    const timeline = await sessionTimeline(fixture.workspace, session.id);
    const ended = await endSession(fixture.workspace, session.id);

    assert.equal(event.captured, true);
    assert.equal(event.event?.redacted, true);
    assert.match(event.event?.input_json ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(event.event?.input_json ?? "", /sk-test-secret/);
    assert.equal(checkpoint.checkpoint.name, "after-redaction");
    assert.equal(timeline.some((entry) => "name" in entry && entry.name === "after-redaction"), true);
    assert.equal(ended.status, "ended");
  } finally {
    await fixture.cleanup();
  }
});

test("session capture hook respects disabled capture by default", async () => {
  const fixture = await createSessionWorkspace("kbx-session-disabled-", defaultConfig);
  const previousCwd = process.cwd();
  try {
    process.chdir(fixture.root);
    const result = await handleSessionCaptureHook(JSON.stringify({
      session_id: "hook-session",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts" }
    })) as { hookSpecificOutput?: { additionalContext?: string } };
    const events = await listSessionEvents(fixture.workspace, "hook-session");

    assert.match(result.hookSpecificOutput?.additionalContext ?? "", /sessions_capture_disabled/);
    assert.equal(events.length, 0);
  } finally {
    process.chdir(previousCwd);
    await fixture.cleanup();
  }
});

test("session rewind previews and restores recorded file snapshots", async () => {
  const fixture = await createSessionWorkspace("kbx-session-rewind-", {
    ...defaultConfig,
    sessions: {
      ...defaultConfig.sessions,
      capture: "full"
    }
  });
  try {
    const filePath = path.join(fixture.root, "notes.md");
    await writeFile(filePath, "before\n", "utf8");
    const session = await startSession(fixture.workspace);
    await writeFile(filePath, "after\n", "utf8");
    await appendSessionEvent(fixture.workspace, {
      sessionId: session.id,
      type: "file_edit",
      summary: "Edited notes",
      files: [{ path: "notes.md", operation: "edit" }],
      snapshots: [{ path: "notes.md", beforeText: "before\n", afterText: "after\n" }]
    });

    const preview = await previewSessionRewind(fixture.workspace, session.id);
    const applied = await applySessionRewind(fixture.workspace, session.id, preview.confirmation);
    const content = await readFile(filePath, "utf8");

    assert.deepEqual(preview.files.map((file) => ({
      path: file.path,
      action: file.action,
      current_matches_recorded_after: file.current_matches_recorded_after
    })), [{
      path: "notes.md",
      action: "restore",
      current_matches_recorded_after: true
    }]);
    assert.equal(applied.rewound, 1);
    assert.equal(content, "before\n");
    await assert.rejects(
      () => applySessionRewind(fixture.workspace, session.id, "wrong-token"),
      /Invalid confirmation/
    );
  } finally {
    await fixture.cleanup();
  }
});

test("session search finds captured events and supports client filtering", async () => {
  const fixture = await createSessionWorkspace("kbx-session-search-", {
    ...defaultConfig,
    sessions: {
      ...defaultConfig.sessions,
      capture: "full"
    }
  });
  try {
    const codex = await startSession(fixture.workspace, {
      name: "Codex implementation",
      client: "codex"
    });
    await appendSessionEvent(fixture.workspace, {
      sessionId: codex.id,
      type: "tool",
      toolName: "shell",
      summary: "Investigated cross thread retrieval",
      input: { command: "kbx session search", token: "sk-test-secret-token-1234567890" },
      files: [{ path: "src/session-store.ts", operation: "edit" }]
    });
    const claude = await startSession(fixture.workspace, {
      name: "Claude docs",
      client: "claude-code"
    });
    await appendSessionEvent(fixture.workspace, {
      sessionId: claude.id,
      type: "note",
      summary: "Reviewed unrelated docs"
    });

    const hits = await searchSessions(fixture.workspace, "cross thread retrieval", { limit: 5 });
    const payloadPreviewHits = await searchSessions(fixture.workspace, "kbx session search", { limit: 5 });
    const payloadHits = await searchSessions(fixture.workspace, "kbx session search", { limit: 5, includePayloads: true });
    const claudeHits = await searchSessions(fixture.workspace, "cross thread retrieval", { client: "claude-code" });

    assert.equal(hits[0]?.session.client, "codex");
    assert.match(hits[0]?.preview ?? "", /cross thread retrieval/);
    assert.equal(hits[0]?.event.input_json, null);
    assert.doesNotMatch(payloadPreviewHits[0]?.preview ?? "", /kbx session search/);
    assert.doesNotMatch(payloadPreviewHits[0]?.preview ?? "", /\[REDACTED\]|sk-test-secret/);
    assert.match(payloadHits[0]?.event.input_json ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(payloadHits[0]?.event.input_json ?? "", /sk-test-secret/);
    assert.equal(claudeHits.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("global session search scans registered workspace session stores", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-global-session-search-"));
  const previousHome = process.env.KBX_HOME;
  process.env.KBX_HOME = path.join(root, "home");
  try {
    const alpha = await createSessionWorkspaceAt(path.join(root, "alpha"), "alpha-workspace", "alpha", defaultConfig);
    const beta = await createSessionWorkspaceAt(path.join(root, "beta"), "beta-workspace", "beta", defaultConfig);
    const alphaSession = await startSession(alpha.workspace, { name: "Alpha Codex", client: "codex" });
    const betaSession = await startSession(beta.workspace, { name: "Beta Claude", client: "claude-code" });
    await appendSessionEvent(alpha.workspace, {
      sessionId: alphaSession.id,
      type: "note",
      summary: "Shared cross assistant lookup token from alpha"
    });
    await appendSessionEvent(beta.workspace, {
      sessionId: betaSession.id,
      type: "note",
      summary: "Shared cross assistant lookup token from beta"
    });
    await mkdir(process.env.KBX_HOME, { recursive: true });
    await writeJson(path.join(process.env.KBX_HOME, "registry.json"), [
      registryEntry("alpha-workspace", "alpha", alpha.root),
      registryEntry("beta-workspace", "beta", beta.root)
    ]);

    const hits = await searchRegisteredSessions("cross assistant lookup token", { limit: 10 });

    assert.deepEqual([...new Set(hits.map((hit) => hit.workspace.name))].sort(), ["alpha", "beta"]);
    assert.equal(hits.some((hit) => hit.session.client === "codex"), true);
    assert.equal(hits.some((hit) => hit.session.client === "claude-code"), true);
  } finally {
    restoreEnv("KBX_HOME", previousHome);
    await rm(root, { recursive: true, force: true });
  }
});

async function createSessionWorkspace(prefix: string, config: WorkspaceConfig) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return createSessionWorkspaceAt(root, "test-workspace", "test", config);
}

async function createSessionWorkspaceAt(root: string, workspaceId: string, name: string, config: WorkspaceConfig) {
  const workspace = workspaceFromRoot(root);
  await mkdir(workspace.kbxDir, { recursive: true });
  await writeJson(workspace.manifestPath, testManifest(workspaceId, name));
  await writeJson(workspace.configPath, config);
  await writeJson(workspace.sourcesPath, []);
  return {
    root,
    workspace,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

function testManifest(workspaceId = "test-workspace", name = "test"): WorkspaceManifest {
  return {
    workspace_id: workspaceId,
    name,
    model: "test-model",
    dim: 3,
    schema_version: SCHEMA_VERSION,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z"
  };
}

function registryEntry(workspace_id: string, name: string, workspacePath: string): RegistryEntry {
  return {
    workspace_id,
    name,
    path: workspacePath,
    created_at: "2026-05-01T00:00:00.000Z",
    last_seen_at: "2026-05-01T00:00:00.000Z"
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
