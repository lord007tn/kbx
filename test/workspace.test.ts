import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceSelector } from "../src/workspace";
import type { RegistryEntry } from "../src/types";

const registry: RegistryEntry[] = [
  {
    workspace_id: "aaa111bbb222",
    name: "app",
    path: "D:\\Work\\app",
    created_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z"
  },
  {
    workspace_id: "ccc333ddd444",
    name: "docs",
    path: "D:\\Work\\docs",
    created_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z"
  }
];

test("resolveWorkspaceSelector resolves short IDs and unique names", () => {
  assert.equal(resolveWorkspaceSelector(registry, "aaa111").workspace_id, "aaa111bbb222");
  assert.equal(resolveWorkspaceSelector(registry, "docs").workspace_id, "ccc333ddd444");
});

test("resolveWorkspaceSelector rejects missing workspaces", () => {
  assert.throws(() => resolveWorkspaceSelector(registry, "missing"), /No registered workspace/);
});

test("resolveWorkspaceSelector rejects ambiguous names", () => {
  assert.throws(
    () => resolveWorkspaceSelector([...registry, { ...registry[1]!, workspace_id: "eee555fff666", name: "app" }], "app"),
    /ambiguous/
  );
});
