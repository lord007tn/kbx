export interface ChunkTags {
  branch_scope?: string;
  branch_name?: string;
  git_head?: string;
  content_hash?: string;
}

export function encodeChunkTags(tags: ChunkTags): string {
  const clean = Object.fromEntries(Object.entries(tags).filter(([, value]) => value !== undefined && value !== ""));
  return Object.keys(clean).length === 0 ? "" : JSON.stringify(clean);
}

export function parseChunkTags(value: string | undefined): ChunkTags {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as Partial<Record<keyof ChunkTags, unknown>>;
    return {
      branch_scope: stringValue(parsed.branch_scope),
      branch_name: stringValue(parsed.branch_name),
      git_head: stringValue(parsed.git_head),
      content_hash: stringValue(parsed.content_hash)
    };
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
