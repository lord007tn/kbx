import type { SearchHit } from "./types";
import { applyOptionalReranker, type RerankerOptions } from "./reranker";

export interface RankedSearchHit extends SearchHit {
  rerankScore: number;
}

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_.:-]+/g) ?? [])]
    .filter((term) => term.length > 1);
}

export function lexicalEnhancementScore(input: {
  query: string;
  terms: string[];
  source: string;
  text: string;
}): number {
  const normalizedQuery = input.query.toLowerCase().trim();
  const normalizedSource = input.source.toLowerCase();
  const normalizedText = input.text.toLowerCase();
  const haystack = `${normalizedSource}\n${normalizedText}`;
  let score = 0;

  if (normalizedQuery.length > 0 && haystack.includes(normalizedQuery)) {
    score += 0.35;
  }
  if (normalizedQuery.length > 0 && normalizedText.includes(normalizedQuery)) {
    score += 0.2;
  }
  if (normalizedQuery.length > 0 && normalizedSource.includes(normalizedQuery)) {
    score += 0.25;
  }

  let matchedTerms = 0;
  for (const term of input.terms) {
    if (!haystack.includes(term)) {
      continue;
    }
    matchedTerms += 1;
    score += 0.08;
    if (normalizedText.includes(term)) {
      score += 0.04;
    }
    if (normalizedSource.includes(term)) {
      score += 0.12;
    }
  }

  if (matchedTerms === 0) {
    return 0;
  }

  const coverage = matchedTerms / Math.max(input.terms.length, 1);
  score += coverage * 0.35;
  score += proximityBoost(normalizedText, input.terms) * 0.25;

  return Math.min(1, score);
}

export function rerankSearchHits(query: string, hits: SearchHit[]): SearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return hits.map((hit) => withSnippet(hit, query));
  }

  return hits
    .map((hit, index): RankedSearchHit => {
      const boost = lexicalEnhancementScore({
        query,
        terms,
        source: hit.source,
        text: hit.text
      });
      const matchBoost = hit.match === "hybrid" ? 0.08 : hit.match === "lexical" ? 0.04 : hit.match === "graph" ? 0.03 : 0;
      const rankTieBreaker = 1 / (1000 + index);
      return {
        ...withSnippet(hit, query),
        rerankScore: hit.score + boost + matchBoost + rankTieBreaker
      };
    })
    .sort((a, b) => b.rerankScore - a.rerankScore || a.source.localeCompare(b.source) || a.chunk_idx - b.chunk_idx)
    .map(({ rerankScore: _rerankScore, ...hit }) => hit);
}

export async function rerankSearchHitsWithOptionalModel(
  query: string,
  hits: SearchHit[],
  options: RerankerOptions = {}
): Promise<SearchHit[]> {
  const deterministic = rerankSearchHits(query, hits);
  return applyOptionalReranker(query, deterministic, options);
}

export function snippetForQuery(text: string, query: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }

  const terms = queryTerms(query);
  const lower = compact.toLowerCase();
  const phraseIndex = lower.indexOf(query.toLowerCase().trim());
  const termIndex = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const anchor = phraseIndex >= 0 ? phraseIndex : termIndex;

  if (anchor === undefined || anchor < 0) {
    return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  const halfWindow = Math.floor(maxChars / 2);
  let start = Math.max(0, anchor - halfWindow);
  let end = Math.min(compact.length, start + maxChars);
  start = Math.max(0, end - maxChars);

  while (start > 0 && !/\s/.test(compact[start - 1] ?? "")) {
    start -= 1;
  }
  while (end < compact.length && !/\s/.test(compact[end] ?? "")) {
    end += 1;
  }

  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  const budget = Math.max(0, maxChars - prefix.length - suffix.length);
  const body = compact.slice(start, end).slice(0, budget).trim();
  return `${prefix}${body}${suffix}`;
}

function withSnippet(hit: SearchHit, query: string): SearchHit {
  return {
    ...hit,
    snippet: hit.snippet ?? snippetForQuery(hit.text, query, 360)
  };
}

function proximityBoost(text: string, terms: string[]): number {
  const positions = terms
    .map((term) => text.indexOf(term))
    .filter((position) => position >= 0);
  if (positions.length < 2) {
    return positions.length === 1 ? 0.1 : 0;
  }
  const span = Math.max(...positions) - Math.min(...positions);
  return 1 / (1 + span / 80);
}
