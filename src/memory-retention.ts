export type SessionMemoryType = "decision" | "preference" | "architecture" | "bug" | "workflow" | "fact" | "handoff" | "event";
export type RetentionTier = "hot" | "warm" | "cold" | "expired";

export interface RetentionScorableMemory {
  type?: SessionMemoryType;
  created_at: string;
  expires_at: string;
  tags?: string[];
  files?: string[];
  source_chunk_ids?: string[];
}

export interface RetentionScore {
  score: number;
  tier: RetentionTier;
  salience: number;
  temporal_decay: number;
  days_remaining: number;
}

const TYPE_SALIENCE: Record<SessionMemoryType, number> = {
  architecture: 0.9,
  preference: 0.85,
  decision: 0.82,
  bug: 0.78,
  workflow: 0.68,
  handoff: 0.62,
  fact: 0.55,
  event: 0.45
};

export function scoreSessionMemoryRetention(memory: RetentionScorableMemory, now = new Date()): RetentionScore {
  const createdAt = Date.parse(memory.created_at);
  const expiresAt = Date.parse(memory.expires_at);
  const nowMs = now.getTime();
  const daysRemaining = Number.isFinite(expiresAt)
    ? Math.ceil((expiresAt - nowMs) / 86_400_000)
    : 0;

  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || daysRemaining <= 0) {
    return {
      score: 0,
      tier: "expired",
      salience: 0,
      temporal_decay: 0,
      days_remaining: Math.min(0, daysRemaining)
    };
  }

  const type = memory.type ?? "fact";
  const metadataBoost = Math.min(0.1, ((memory.tags?.length ?? 0) + (memory.files?.length ?? 0) + (memory.source_chunk_ids?.length ?? 0)) * 0.02);
  const salience = Math.min(1, (TYPE_SALIENCE[type] ?? TYPE_SALIENCE.fact) + metadataBoost);
  const ageDays = Math.max(0, (nowMs - createdAt) / 86_400_000);
  const temporalDecay = Math.exp(-0.012 * ageDays);
  const expiryWindowDays = Math.max(1, (expiresAt - createdAt) / 86_400_000);
  const remainingRatio = Math.max(0, Math.min(1, daysRemaining / expiryWindowDays));
  const score = clamp01(salience * temporalDecay * (0.85 + remainingRatio * 0.15));

  return {
    score,
    tier: tierForScore(score),
    salience,
    temporal_decay: temporalDecay,
    days_remaining: daysRemaining
  };
}

function tierForScore(score: number): RetentionTier {
  if (score >= 0.7) return "hot";
  if (score >= 0.4) return "warm";
  return "cold";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
