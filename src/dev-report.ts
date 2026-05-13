import { createId } from "@paralleldrive/cuid2";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type Workspace } from "./workspace";

export interface DevReportInput {
  task: string;
  summary: string;
  issues?: string[];
  findings?: string[];
  good?: string[];
  next?: string[];
  source?: string;
}

export interface DevReportRecord {
  path: string;
  relative_path: string;
  created_at: string;
  skipped?: boolean;
  reason?: string;
}

export interface DevReportListEntry {
  path: string;
  relative_path: string;
  created_at: string;
  preview: string;
}

export async function addDevReport(workspace: Workspace, input: DevReportInput): Promise<DevReportRecord> {
  const config = await loadConfig(workspace);
  if (config.dev.report !== "enabled") {
    return {
      path: debugReportDir(workspace),
      relative_path: ".kbx/debug/reports",
      created_at: new Date().toISOString(),
      skipped: true,
      reason: "dev_report_disabled"
    };
  }

  const createdAt = new Date().toISOString();
  const reportDir = debugReportDir(workspace);
  await mkdir(reportDir, { recursive: true });
  const filename = `${createdAt.replace(/[:.]/g, "-")}-${createId().slice(0, 8)}.md`;
  const filePath = path.join(reportDir, filename);
  await writeFile(filePath, formatDevReport(input, createdAt), "utf8");
  return {
    path: filePath,
    relative_path: toWorkspaceRelative(workspace, filePath),
    created_at: createdAt
  };
}

export async function listDevReports(workspace: Workspace, limit = 20): Promise<DevReportListEntry[]> {
  const reportDir = debugReportDir(workspace);
  let files: string[];
  try {
    files = await readdir(reportDir);
  } catch {
    return [];
  }

  const markdownFiles = files
    .filter((file) => file.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, limit);

  const entries: DevReportListEntry[] = [];
  for (const file of markdownFiles) {
    const filePath = path.join(reportDir, file);
    const content = await readFile(filePath, "utf8");
    entries.push({
      path: filePath,
      relative_path: toWorkspaceRelative(workspace, filePath),
      created_at: createdAtFromFilename(file) ?? "",
      preview: preview(content)
    });
  }
  return entries;
}

function formatDevReport(input: DevReportInput, createdAt: string): string {
  const sections = [
    "# kbx dev report",
    "",
    `Created: ${createdAt}`,
    `Source: ${input.source?.trim() || "codex"}`,
    `Task: ${input.task.trim()}`,
    "",
    "## Summary",
    "",
    input.summary.trim(),
    "",
    listSection("Issues", input.issues),
    listSection("Findings", input.findings),
    listSection("Good", input.good),
    listSection("Next", input.next)
  ].filter((section) => section !== null);

  return `${sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function listSection(title: string, values: string[] | undefined): string | null {
  const clean = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (clean.length === 0) {
    return null;
  }
  return [`## ${title}`, "", ...clean.map((value) => `- ${value}`), ""].join("\n");
}

function debugReportDir(workspace: Workspace): string {
  return path.join(workspace.kbxDir, "debug", "reports");
}

function toWorkspaceRelative(workspace: Workspace, filePath: string): string {
  return path.relative(workspace.root, filePath).replaceAll("\\", "/");
}

function createdAtFromFilename(file: string): string | null {
  const match = /^(?<date>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3})/.exec(file);
  return match?.groups?.date?.replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})/,
    "T$1:$2:$3.$4Z"
  ) ?? null;
}

function preview(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}
