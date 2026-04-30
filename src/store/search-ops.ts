// Layer 4: Query expansion, reranking, and RRF fusion

import type { Database } from "../db.js";
import { DEFAULT_QUERY_MODEL, DEFAULT_RERANK_MODEL } from "./config.js";
import { getCacheKey, getCachedResult, setCachedResult } from "./cache.js";
import { getDefaultLlamaCpp, type LlamaCpp, type RerankDocument } from "../llm.js";
import type { ExpandedQuery } from "./config.js";
import type { RankedResult, RRFContributionTrace, RRFScoreTrace } from "./documents.js";
import type { RankedListMeta } from "./search-helpers.js";

export type { RankedResult, RRFContributionTrace, RRFScoreTrace };

export async function expandQuery(
  query: string,
  model: string = DEFAULT_QUERY_MODEL,
  db: Database,
  intent?: string,
  llmOverride?: LlamaCpp
): Promise<ExpandedQuery[]> {
  const cacheKey = getCacheKey("expandQuery", { query, model, ...(intent && { intent }) });
  const cached = getCachedResult(db, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as any[];
      if (parsed.length > 0 && parsed[0].query) {
        return parsed as ExpandedQuery[];
      } else if (parsed.length > 0 && parsed[0].text) {
        return parsed.map((r: any) => ({ type: r.type, query: r.text }));
      }
    } catch {
      // Old cache format — re-expand
    }
  }

  const llm = llmOverride ?? getDefaultLlamaCpp();
  const results = await llm.expandQuery(query, { intent });

  const expanded: ExpandedQuery[] = results
    .filter(r => r.text !== query)
    .map(r => ({ type: r.type, query: r.text }));

  if (expanded.length > 0) {
    setCachedResult(db, cacheKey, JSON.stringify(expanded));
  }

  return expanded;
}

export async function rerank(
  query: string,
  documents: { file: string; text: string }[],
  model: string = DEFAULT_RERANK_MODEL,
  db: Database,
  intent?: string,
  llmOverride?: LlamaCpp
): Promise<{ file: string; score: number }[]> {
  const rerankQuery = intent ? `${intent}\n\n${query}` : query;

  const cachedResults: Map<string, number> = new Map();
  const uncachedDocsByChunk: Map<string, RerankDocument> = new Map();

  for (const doc of documents) {
    const cacheKey = getCacheKey("rerank", { query: rerankQuery, model, chunk: doc.text });
    const legacyCacheKey = getCacheKey("rerank", { query, file: doc.file, model, chunk: doc.text });
    const cached = getCachedResult(db, cacheKey) ?? getCachedResult(db, legacyCacheKey);
    if (cached !== null) {
      cachedResults.set(doc.text, parseFloat(cached));
    } else {
      uncachedDocsByChunk.set(doc.text, { file: doc.file, text: doc.text });
    }
  }

  if (uncachedDocsByChunk.size > 0) {
    const llm = llmOverride ?? getDefaultLlamaCpp();
    const uncachedDocs = [...uncachedDocsByChunk.values()];
    const rerankResult = await llm.rerank(rerankQuery, uncachedDocs, { model });

    const textByFile = new Map(uncachedDocs.map(d => [d.file, d.text]));
    for (const result of rerankResult.results) {
      const chunk = textByFile.get(result.file) || "";
      const cacheKey = getCacheKey("rerank", { query: rerankQuery, model, chunk });
      setCachedResult(db, cacheKey, result.score.toString());
      cachedResults.set(chunk, result.score);
    }
  }

  return documents
    .map(doc => ({ file: doc.file, score: cachedResults.get(doc.text) || 0 }))
    .sort((a, b) => b.score - a.score);
}

export function reciprocalRankFusion(
  resultLists: RankedResult[][],
  weights: number[] = [],
  k: number = 60
): RankedResult[] {
  const scores = new Map<string, { result: RankedResult; rrfScore: number; topRank: number }>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      if (!result) continue;
      const rrfContribution = weight / (k + rank + 1);
      const existing = scores.get(result.file);

      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.topRank = Math.min(existing.topRank, rank);
      } else {
        scores.set(result.file, {
          result,
          rrfScore: rrfContribution,
          topRank: rank,
        });
      }
    }
  }

  for (const entry of scores.values()) {
    if (entry.topRank === 0) {
      entry.rrfScore += 0.05;
    } else if (entry.topRank <= 2) {
      entry.rrfScore += 0.02;
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(e => ({ ...e.result, score: e.rrfScore }));
}

export function buildRrfTrace(
  resultLists: RankedResult[][],
  weights: number[] = [],
  listMeta: RankedListMeta[] = [],
  k: number = 60
): Map<string, RRFScoreTrace> {
  const traces = new Map<string, RRFScoreTrace>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;
    const meta = listMeta[listIdx] ?? {
      source: "fts",
      queryType: "original",
      query: "",
    } as const;

    for (let rank0 = 0; rank0 < list.length; rank0++) {
      const result = list[rank0];
      if (!result) continue;
      const rank = rank0 + 1;
      const contribution = weight / (k + rank);
      const existing = traces.get(result.file);

      const detail: RRFContributionTrace = {
        listIndex: listIdx,
        source: meta.source,
        queryType: meta.queryType,
        query: meta.query,
        rank,
        weight,
        backendScore: result.score,
        rrfContribution: contribution,
      };

      if (existing) {
        existing.baseScore += contribution;
        existing.topRank = Math.min(existing.topRank, rank);
        existing.contributions.push(detail);
      } else {
        traces.set(result.file, {
          contributions: [detail],
          baseScore: contribution,
          topRank: rank,
          topRankBonus: 0,
          totalScore: 0,
        });
      }
    }
  }

  for (const trace of traces.values()) {
    let bonus = 0;
    if (trace.topRank === 1) bonus = 0.05;
    else if (trace.topRank <= 3) bonus = 0.02;
    trace.topRankBonus = bonus;
    trace.totalScore = trace.baseScore + bonus;
  }

  return traces;
}
