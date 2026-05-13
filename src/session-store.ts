import { createId } from "@paralleldrive/cuid2";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentBranchContext } from "./branch";
import type { WorkspaceConfig } from "./types";
import { loadConfig, loadManifest, type Workspace } from "./workspace";

const SESSION_SCHEMA_VERSION = 1;

export type SessionStatus = "active" | "ended";
export type SessionEventType = "prompt" | "assistant" | "tool" | "file_edit" | "checkpoint" | "note" | "error" | "other";

export interface SessionRecord {
  id: string;
  workspace_id: string;
  name: string | null;
  client: string | null;
  cwd: string | null;
  branch_name: string | null;
  branch_scope: string | null;
  git_head: string | null;
  started_at: string;
  ended_at: string | null;
  status: SessionStatus;
}

export interface SessionEventRecord {
  id: string;
  session_id: string;
  seq: number;
  timestamp: string;
  type: SessionEventType;
  tool_name: string | null;
  summary: string;
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  redacted: boolean;
  truncated: boolean;
  files: SessionEventFile[];
  snapshots: SessionFileSnapshot[];
}

export interface SessionEventFile {
  path: string;
  operation: string;
}

export interface SessionFileSnapshot {
  path: string;
  before_text: string | null;
  after_text: string | null;
}

export interface StartSessionOptions {
  id?: string;
  name?: string;
  client?: string;
  cwd?: string;
}

export interface AppendSessionEventInput {
  sessionId: string;
  type: SessionEventType;
  timestamp?: string;
  toolName?: string;
  summary?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  files?: SessionEventFile[];
  snapshots?: Array<{
    path: string;
    beforeText?: string | null;
    afterText?: string | null;
  }>;
}

export interface AppendSessionEventOptions {
  respectCaptureConfig?: boolean;
}

export interface AppendSessionEventResult {
  captured: boolean;
  event?: SessionEventRecord;
  reason?: string;
}

export interface SessionRewindPreview {
  session_id: string;
  confirmation: string;
  files: Array<{
    path: string;
    action: "restore" | "delete";
    event_count: number;
    current_matches_recorded_after: boolean | null;
  }>;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  name: string | null;
  client: string | null;
  cwd: string | null;
  branch_name: string | null;
  branch_scope: string | null;
  git_head: string | null;
  started_at: string;
  ended_at: string | null;
  status: SessionStatus;
}

interface SessionEventRow {
  id: string;
  session_id: string;
  seq: number;
  timestamp: string;
  type: SessionEventType;
  tool_name: string | null;
  summary: string;
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  redacted: 0 | 1;
  truncated: 0 | 1;
}

interface CheckpointRow {
  id: string;
  session_id: string;
  seq: number;
  name: string;
  note: string | null;
  created_at: string;
}

export type SessionCheckpointRecord = CheckpointRow;

export async function startSession(workspace: Workspace, options: StartSessionOptions = {}): Promise<SessionRecord> {
  const db = openSessionDb(workspace);
  try {
    const manifest = await loadManifest(workspace);
    const branch = await currentBranchContext(workspace.root);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: options.id ?? createId(),
      workspace_id: manifest.workspace_id,
      name: options.name ?? null,
      client: options.client ?? null,
      cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
      branch_name: branch?.name ?? null,
      branch_scope: branch?.scope ?? null,
      git_head: branch?.head ?? null,
      started_at: now,
      ended_at: null,
      status: "active"
    };
    db.prepare(`
      INSERT INTO sessions (
        id, workspace_id, name, client, cwd, branch_name, branch_scope, git_head, started_at, ended_at, status
      ) VALUES (
        @id, @workspace_id, @name, @client, @cwd, @branch_name, @branch_scope, @git_head, @started_at, @ended_at, @status
      )
    `).run(record);
    return record;
  } finally {
    db.close();
  }
}

export async function endSession(workspace: Workspace, sessionId: string): Promise<SessionRecord> {
  const db = openSessionDb(workspace);
  try {
    db.prepare("UPDATE sessions SET ended_at = ?, status = 'ended' WHERE id = ?").run(new Date().toISOString(), sessionId);
    const session = rowToSession(db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined);
    if (!session) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    return session;
  } finally {
    db.close();
  }
}

export async function listSessions(workspace: Workspace, options: { limit?: number } = {}): Promise<SessionRecord[]> {
  const db = openSessionDb(workspace);
  try {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const rows = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit) as SessionRow[];
    return rows.map((row) => rowToSession(row)!);
  } finally {
    db.close();
  }
}

export async function getSession(workspace: Workspace, sessionId: string): Promise<SessionRecord | null> {
  const db = openSessionDb(workspace);
  try {
    return rowToSession(db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined);
  } finally {
    db.close();
  }
}

export async function appendSessionEvent(
  workspace: Workspace,
  input: AppendSessionEventInput,
  options: AppendSessionEventOptions = {}
): Promise<AppendSessionEventResult> {
  const config = await loadConfig(workspace);
  if (options.respectCaptureConfig === true && config.sessions.capture === "disabled") {
    return { captured: false, reason: "sessions_capture_disabled" };
  }

  const db = openSessionDb(workspace);
  try {
    await ensureSession(db, workspace, input.sessionId);
    const event = insertSessionEvent(db, input, config);
    return { captured: true, event };
  } finally {
    db.close();
  }
}

export async function listSessionEvents(workspace: Workspace, sessionId: string, options: { limit?: number } = {}): Promise<SessionEventRecord[]> {
  const db = openSessionDb(workspace);
  try {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC LIMIT ?").all(sessionId, limit) as SessionEventRow[];
    return rows.map((row) => hydrateEvent(db, row));
  } finally {
    db.close();
  }
}

export async function addSessionCheckpoint(
  workspace: Workspace,
  sessionId: string,
  name: string,
  note?: string
): Promise<{ checkpoint: SessionCheckpointRecord; event: SessionEventRecord }> {
  const eventResult = await appendSessionEvent(workspace, {
    sessionId,
    type: "checkpoint",
    summary: name,
    input: note ? { note } : undefined
  });
  if (!eventResult.event) {
    throw new Error("Checkpoint event was not captured.");
  }

  const db = openSessionDb(workspace);
  try {
    const checkpoint: CheckpointRow = {
      id: createId(),
      session_id: sessionId,
      seq: eventResult.event.seq,
      name,
      note: note ?? null,
      created_at: eventResult.event.timestamp
    };
    db.prepare(`
      INSERT INTO session_checkpoints (id, session_id, seq, name, note, created_at)
      VALUES (@id, @session_id, @seq, @name, @note, @created_at)
    `).run(checkpoint);
    return { checkpoint, event: eventResult.event };
  } finally {
    db.close();
  }
}

export async function sessionTimeline(workspace: Workspace, sessionId: string): Promise<Array<SessionEventRecord | SessionCheckpointRecord>> {
  const db = openSessionDb(workspace);
  try {
    const eventRows = db.prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC").all(sessionId) as SessionEventRow[];
    const checkpoints = db.prepare("SELECT * FROM session_checkpoints WHERE session_id = ? ORDER BY seq ASC").all(sessionId) as CheckpointRow[];
    const checkpointBySeq = new Map(checkpoints.map((checkpoint) => [checkpoint.seq, checkpoint]));
    const timeline: Array<SessionEventRecord | CheckpointRow> = [];
    for (const row of eventRows) {
      timeline.push(hydrateEvent(db, row));
      const checkpoint = checkpointBySeq.get(row.seq);
      if (checkpoint) {
        timeline.push(checkpoint);
      }
    }
    return timeline;
  } finally {
    db.close();
  }
}

export async function pruneSessions(workspace: Workspace, retentionDays?: number): Promise<number> {
  const config = await loadConfig(workspace);
  const days = retentionDays ?? config.sessions.retention_days;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const db = openSessionDb(workspace);
  try {
    const result = db.prepare(`
      DELETE FROM sessions
      WHERE COALESCE(ended_at, started_at) < ?
    `).run(cutoff);
    return Number(result.changes);
  } finally {
    db.close();
  }
}

export async function previewSessionRewind(workspace: Workspace, sessionId: string): Promise<SessionRewindPreview> {
  const db = openSessionDb(workspace);
  try {
    const manifest = await loadManifest(workspace);
    const snapshots = snapshotsForSession(db, sessionId);
    const grouped = groupSnapshots(snapshots);
    const files = [];
    for (const entry of grouped) {
      files.push({
        path: entry.path,
        action: entry.beforeText === null ? "delete" as const : "restore" as const,
        event_count: entry.eventCount,
        current_matches_recorded_after: await currentMatches(workspace, entry.path, entry.afterText)
      });
    }
    return {
      session_id: sessionId,
      confirmation: rewindConfirmation(manifest.workspace_id, sessionId),
      files
    };
  } finally {
    db.close();
  }
}

export async function applySessionRewind(
  workspace: Workspace,
  sessionId: string,
  confirm: string
): Promise<{ rewound: number; files: SessionRewindPreview["files"] }> {
  const manifest = await loadManifest(workspace);
  const required = rewindConfirmation(manifest.workspace_id, sessionId);
  if (confirm !== required) {
    throw new Error(`Invalid confirmation. Required: ${required}`);
  }

  const preview = await previewSessionRewind(workspace, sessionId);
  const db = openSessionDb(workspace);
  try {
    const grouped = groupSnapshots(snapshotsForSession(db, sessionId));
    for (const entry of grouped) {
      const absolutePath = safeWorkspacePath(workspace, entry.path);
      if (entry.beforeText === null) {
        await rm(absolutePath, { force: true });
      } else {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, entry.beforeText, "utf8");
      }
    }
    return { rewound: grouped.length, files: preview.files };
  } finally {
    db.close();
  }
}

function openSessionDb(workspace: Workspace): Database.Database {
  mkdirSync(workspace.kbxDir, { recursive: true });
  const db = new Database(workspace.sessionPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const userVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (userVersion > SESSION_SCHEMA_VERSION) {
    throw new Error(`Unsupported session schema ${userVersion}. Upgrade kbx to read this workspace.`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT,
      client TEXT,
      cwd TEXT,
      branch_name TEXT,
      branch_scope TEXT,
      git_head TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions(started_at);

    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      tool_name TEXT,
      summary TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      redacted INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, seq),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS session_events_session_idx ON session_events(session_id, seq);

    CREATE TABLE IF NOT EXISTS session_event_files (
      event_id TEXT NOT NULL,
      path TEXT NOT NULL,
      operation TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES session_events(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS session_event_files_event_idx ON session_event_files(event_id);

    CREATE TABLE IF NOT EXISTS session_file_snapshots (
      event_id TEXT NOT NULL,
      path TEXT NOT NULL,
      before_text TEXT,
      after_text TEXT,
      FOREIGN KEY (event_id) REFERENCES session_events(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS session_file_snapshots_event_idx ON session_file_snapshots(event_id);

    CREATE TABLE IF NOT EXISTS session_checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      name TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS session_checkpoints_session_idx ON session_checkpoints(session_id, seq);
  `);
  db.pragma(`user_version = ${SESSION_SCHEMA_VERSION}`);
}

async function ensureSession(db: Database.Database, workspace: Workspace, sessionId: string): Promise<void> {
  const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as { id: string } | undefined;
  if (existing) {
    return;
  }
  const manifest = await loadManifest(workspace);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions (
      id, workspace_id, name, client, cwd, branch_name, branch_scope, git_head, started_at, ended_at, status
    ) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, 'active')
  `).run(sessionId, manifest.workspace_id, process.cwd(), now);
}

function insertSessionEvent(db: Database.Database, input: AppendSessionEventInput, config: WorkspaceConfig): SessionEventRecord {
  const eventId = createId();
  const seq = nextSessionSeq(db, input.sessionId);
  const inputStored = storedJson(input.input, config);
  const outputStored = storedJson(input.output, config);
  const snapshots = (input.snapshots ?? []).map((snapshot) => {
    const before = storedText(snapshot.beforeText, config);
    const after = storedText(snapshot.afterText, config);
    return {
      path: normalizeStoredPath(snapshot.path),
      before_text: before.value,
      after_text: after.value,
      redacted: before.redacted || after.redacted,
      truncated: before.truncated || after.truncated
    };
  });
  const sanitizedError = input.error ? redactSensitiveText(input.error) : null;
  const redacted = inputStored.redacted
    || outputStored.redacted
    || (input.error !== undefined && sanitizedError !== input.error)
    || snapshots.some((snapshot) => snapshot.redacted);
  const truncated = inputStored.truncated || outputStored.truncated || snapshots.some((snapshot) => snapshot.truncated);
  const row: SessionEventRow = {
    id: eventId,
    session_id: input.sessionId,
    seq,
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    tool_name: input.toolName ?? null,
    summary: summarizeEvent(input),
    input_json: config.sessions.capture === "full" ? inputStored.value : null,
    output_json: config.sessions.capture === "full" ? outputStored.value : null,
    error: sanitizedError,
    redacted: redacted ? 1 : 0,
    truncated: truncated ? 1 : 0
  };

  const files = (input.files ?? []).map((file) => ({
    path: normalizeStoredPath(file.path),
    operation: file.operation
  }));

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO session_events (
        id, session_id, seq, timestamp, type, tool_name, summary, input_json, output_json, error, redacted, truncated
      ) VALUES (
        @id, @session_id, @seq, @timestamp, @type, @tool_name, @summary, @input_json, @output_json, @error, @redacted, @truncated
      )
    `).run(row);
    const insertFile = db.prepare("INSERT INTO session_event_files (event_id, path, operation) VALUES (?, ?, ?)");
    for (const file of files) {
      insertFile.run(eventId, file.path, file.operation);
    }
    const insertSnapshot = db.prepare("INSERT INTO session_file_snapshots (event_id, path, before_text, after_text) VALUES (?, ?, ?, ?)");
    for (const snapshot of snapshots) {
      insertSnapshot.run(eventId, snapshot.path, snapshot.before_text, snapshot.after_text);
    }
  });
  transaction();
  return {
    ...rowToEvent(row),
    files,
    snapshots: snapshots.map((snapshot) => ({
      path: snapshot.path,
      before_text: snapshot.before_text,
      after_text: snapshot.after_text
    }))
  };
}

function nextSessionSeq(db: Database.Database, sessionId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE session_id = ?").get(sessionId) as { seq: number };
  return row.seq;
}

function hydrateEvent(db: Database.Database, row: SessionEventRow): SessionEventRecord {
  const event = rowToEvent(row);
  const files = db.prepare("SELECT path, operation FROM session_event_files WHERE event_id = ? ORDER BY path").all(row.id) as SessionEventFile[];
  const snapshots = db.prepare("SELECT path, before_text, after_text FROM session_file_snapshots WHERE event_id = ? ORDER BY path").all(row.id) as SessionFileSnapshot[];
  return {
    ...event,
    files,
    snapshots
  };
}

function rowToSession(row: SessionRow | undefined): SessionRecord | null {
  return row ? { ...row } : null;
}

function rowToEvent(row: SessionEventRow): SessionEventRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    seq: row.seq,
    timestamp: row.timestamp,
    type: row.type,
    tool_name: row.tool_name,
    summary: row.summary,
    input_json: row.input_json,
    output_json: row.output_json,
    error: row.error,
    redacted: row.redacted === 1,
    truncated: row.truncated === 1,
    files: [],
    snapshots: []
  };
}

function storedJson(value: unknown, config: WorkspaceConfig): { value: string | null; redacted: boolean; truncated: boolean } {
  if (value === undefined || value === null || config.sessions.capture !== "full") {
    return { value: null, redacted: false, truncated: false };
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return storedText(serialized, config);
}

function storedText(value: string | null | undefined, config: WorkspaceConfig): { value: string | null; redacted: boolean; truncated: boolean } {
  if (value === undefined || value === null) {
    return { value: null, redacted: false, truncated: false };
  }
  const redactedValue = redactSensitiveText(value);
  const redacted = redactedValue !== value;
  const maxBytes = config.sessions.max_event_bytes;
  if (Buffer.byteLength(redactedValue, "utf8") <= maxBytes) {
    return { value: redactedValue, redacted, truncated: false };
  }
  const marker = "\n[truncated]";
  const targetBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let next = redactedValue;
  while (Buffer.byteLength(next, "utf8") > targetBytes && next.length > 0) {
    next = next.slice(0, -1);
  }
  return { value: `${next}${marker}`, redacted, truncated: true };
}

function summarizeEvent(input: AppendSessionEventInput): string {
  if (input.summary?.trim()) {
    return redactSensitiveText(input.summary.trim()).slice(0, 500);
  }
  if (input.type === "tool" && input.toolName) {
    return `Tool: ${input.toolName}`;
  }
  if (input.type === "file_edit" && input.files?.length) {
    return `Edited ${input.files.map((file) => file.path).join(", ")}`;
  }
  return input.type;
}

function redactSensitiveText(value: string): string {
  let next = value.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
  next = next.replace(/\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^"'\s,}]+/gi, (match) => {
    const [key] = match.split(/[:=]/);
    return `${key?.trim() ?? "secret"}=[REDACTED]`;
  });
  next = next.replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]");
  next = next.replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "[REDACTED]");
  return next;
}

function normalizeStoredPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function rewindConfirmation(workspaceId: string, sessionId: string): string {
  return `rewind-session:${workspaceId}:${sessionId}`;
}

interface SnapshotWithSeq extends SessionFileSnapshot {
  seq: number;
}

function snapshotsForSession(db: Database.Database, sessionId: string): SnapshotWithSeq[] {
  return db.prepare(`
    SELECT s.path, s.before_text, s.after_text, e.seq
    FROM session_file_snapshots s
    JOIN session_events e ON e.id = s.event_id
    WHERE e.session_id = ?
    ORDER BY e.seq ASC
  `).all(sessionId) as SnapshotWithSeq[];
}

function groupSnapshots(snapshots: SnapshotWithSeq[]): Array<{
  path: string;
  beforeText: string | null;
  afterText: string | null;
  eventCount: number;
}> {
  const byPath = new Map<string, SnapshotWithSeq[]>();
  for (const snapshot of snapshots) {
    const current = byPath.get(snapshot.path) ?? [];
    current.push(snapshot);
    byPath.set(snapshot.path, current);
  }
  return [...byPath.entries()]
    .map(([filePath, entries]) => {
      const sorted = entries.sort((a, b) => a.seq - b.seq);
      return {
        path: filePath,
        beforeText: sorted[0]?.before_text ?? null,
        afterText: sorted[sorted.length - 1]?.after_text ?? null,
        eventCount: sorted.length
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function currentMatches(workspace: Workspace, filePath: string, afterText: string | null): Promise<boolean | null> {
  if (afterText === null) {
    return null;
  }
  try {
    const current = await readFile(safeWorkspacePath(workspace, filePath), "utf8");
    return current === afterText;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function safeWorkspacePath(workspace: Workspace, filePath: string): string {
  const absolutePath = path.resolve(workspace.root, filePath);
  const relative = path.relative(workspace.root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to rewind path outside workspace: ${filePath}`);
  }
  const normalized = relative.replaceAll("\\", "/");
  if (normalized === ".kbx" || normalized.startsWith(".kbx/")) {
    throw new Error(`Refusing to rewind kbx internal path: ${filePath}`);
  }
  return absolutePath;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
