export interface RetrievalEvalCase {
  id: string;
  query: string;
  relevant: string[];
}

export interface RetrievalEvalHit {
  source: string;
  id?: string;
}

export interface RetrievalEvalCaseResult {
  id: string;
  query: string;
  expected: string[];
  found: string[];
  reciprocalRank: number;
  recall: number;
  hit: boolean;
}

export interface RetrievalEvalSummary {
  cases: number;
  meanReciprocalRank: number;
  recallAtK: number;
  hitRate: number;
  results: RetrievalEvalCaseResult[];
}

export function evaluateRetrieval(
  cases: RetrievalEvalCase[],
  resultsByCaseId: Map<string, RetrievalEvalHit[]>,
  topK: number
): RetrievalEvalSummary {
  const results = cases.map((testCase) => {
    const expected = new Set(testCase.relevant);
    const found = (resultsByCaseId.get(testCase.id) ?? []).slice(0, topK).map((hit) => hit.source);
    const firstRelevantIndex = found.findIndex((source) => expected.has(source));
    const relevantFound = new Set(found.filter((source) => expected.has(source))).size;
    return {
      id: testCase.id,
      query: testCase.query,
      expected: testCase.relevant,
      found,
      reciprocalRank: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
      recall: testCase.relevant.length > 0 ? relevantFound / testCase.relevant.length : 0,
      hit: firstRelevantIndex >= 0
    };
  });

  return {
    cases: cases.length,
    meanReciprocalRank: mean(results.map((result) => result.reciprocalRank)),
    recallAtK: mean(results.map((result) => result.recall)),
    hitRate: mean(results.map((result) => result.hit ? 1 : 0)),
    results
  };
}

export function parseRetrievalEvalCorpus(value: string): RetrievalEvalCase[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Retrieval eval corpus must be a JSON array.");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Eval case ${index + 1} must be an object.`);
    }
    const candidate = entry as Partial<RetrievalEvalCase>;
    if (typeof candidate.id !== "string" || typeof candidate.query !== "string" || !Array.isArray(candidate.relevant)) {
      throw new Error(`Eval case ${index + 1} must include id, query, and relevant.`);
    }
    if (!candidate.relevant.every((source) => typeof source === "string")) {
      throw new Error(`Eval case ${candidate.id} relevant entries must be source strings.`);
    }
    return {
      id: candidate.id,
      query: candidate.query,
      relevant: candidate.relevant
    };
  });
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
