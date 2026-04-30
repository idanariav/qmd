// Commands: search (tsearch), vectorSearch (vsearch), querySearch (hsearch), filterSearch (fsearch)

import {
  searchFTS,
  getContextForFile,
  hybridQuery,
  vectorSearchQuery,
  structuredSearch,
  findByFilter,
  extractSnippet,
  addLineNumbers,
  parseVirtualPath,
  buildVirtualPath,
  resolveVirtualPath,
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
} from "../../store.js";
import type { ExpandedQuery, FindResult } from "../../store.js";
import { withLLMSession } from "../../llm.js";
import {
  getCollection as getCollectionFromYaml,
  getDefaultCollectionNames,
} from "../../collections.js";
import {
  formatSearchResults,
  escapeCSV,
} from "../formatter.js";
import type { OutputFormat } from "../formatter.js";
import { getStore, getDb, getActiveIndexName, closeDb } from "../store-access.js";
import { c, useColor, checkIndexHealth, formatMs, progress } from "../utils.js";
import { buildEditorUri, termLink, getEditorUriTemplate } from "../uri.js";
import type { OutputOptions, OutputRow, EmptySearchReason } from "../args.js";

export type { OutputOptions, OutputRow, EmptySearchReason };

interface ParsedStructuredQuery {
  searches: ExpandedQuery[];
  intent?: string;
}

function sanitizeFTS5Term(term: string): string {
  return term.replace(/[^\w']/g, '').trim();
}

function buildFTS5Query(query: string): string {
  const sanitizedQuery = query.replace(/[^\w\s']/g, '').trim();

  const terms = query
    .split(/\s+/)
    .map(sanitizeFTS5Term)
    .filter(term => term.length >= 2);

  if (terms.length === 0) return "";
  if (terms.length === 1) return `"${terms[0]!.replace(/"/g, '""')}"`;

  const phrase = `"${sanitizedQuery.replace(/"/g, '""')}"`;
  const quotedTerms = terms.map(t => `"${t.replace(/"/g, '""')}"`);
  const nearPhrase = `NEAR(${quotedTerms.join(' ')}, 10)`;
  const orTerms = quotedTerms.join(' OR ');

  return `(${phrase}) OR (${nearPhrase}) OR (${orTerms})`;
}

function normalizeBM25(score: number): number {
  const absScore = Math.abs(score);
  return 1 / (1 + Math.exp(-(absScore - 5) / 3));
}

function highlightTerms(text: string, query: string): string {
  if (!useColor) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  let result = text;
  for (const term of terms) {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, `${c.yellow}${c.bold}$1${c.reset}`);
  }
  return result;
}

function formatScore(score: number): string {
  const pct = (score * 100).toFixed(0).padStart(3);
  if (!useColor) return `${pct}%`;
  if (score >= 0.7) return `${c.green}${pct}%${c.reset}`;
  if (score >= 0.4) return `${c.yellow}${pct}%${c.reset}`;
  return `${c.dim}${pct}%${c.reset}`;
}

function formatExplainNumber(value: number): string {
  return value.toFixed(4);
}

function printEmptySearchResults(format: OutputFormat, reason: EmptySearchReason = "no_results"): void {
  if (format === "json") { console.log("[]"); return; }
  if (format === "csv") { console.log("docid,score,file,title,context,line,snippet"); return; }
  if (format === "xml") { console.log("<results></results>"); return; }
  if (format === "md" || format === "files") return;
  if (reason === "min_score") { console.log("No results found above minimum score threshold."); return; }
  console.log("No results found.");
}

export function resolveCollectionFilter(raw: string | string[] | undefined, useDefaults: boolean = false): string[] {
  if (!raw && useDefaults) return getDefaultCollectionNames();
  if (!raw) return [];
  const names = Array.isArray(raw) ? raw : [raw];
  const validated: string[] = [];
  for (const name of names) {
    const coll = getCollectionFromYaml(name);
    if (!coll) {
      console.error(`Collection not found: ${name}`);
      closeDb();
      process.exit(1);
    }
    validated.push(name);
  }
  return validated;
}

export function filterByCollections<T extends { filepath?: string; file?: string }>(results: T[], collectionNames: string[]): T[] {
  if (collectionNames.length <= 1) return results;
  const prefixes = collectionNames.map(n => `qmd://${n}/`);
  return results.filter(r => {
    const path = r.filepath || r.file || '';
    return prefixes.some(p => path.startsWith(p));
  });
}

function parseStructuredQuery(query: string): ParsedStructuredQuery | null {
  const rawLines = query.split('\n').map((line, idx) => ({
    raw: line,
    trimmed: line.trim(),
    number: idx + 1,
  })).filter(line => line.trimmed.length > 0);

  if (rawLines.length === 0) return null;

  const prefixRe = /^(lex|vec|hyde):\s*/i;
  const expandRe = /^expand:\s*/i;
  const intentRe = /^intent:\s*/i;
  const typed: ExpandedQuery[] = [];
  let intent: string | undefined;

  for (const line of rawLines) {
    if (expandRe.test(line.trimmed)) {
      if (rawLines.length > 1) {
        throw new Error(`Line ${line.number} starts with expand:, but query documents cannot mix expand with typed lines. Submit a single expand query instead.`);
      }
      const text = line.trimmed.replace(expandRe, '').trim();
      if (!text) throw new Error('expand: query must include text.');
      return null;
    }

    if (intentRe.test(line.trimmed)) {
      if (intent !== undefined) {
        throw new Error(`Line ${line.number}: only one intent: line is allowed per query document.`);
      }
      const text = line.trimmed.replace(intentRe, '').trim();
      if (!text) throw new Error(`Line ${line.number}: intent: must include text.`);
      intent = text;
      continue;
    }

    const match = line.trimmed.match(prefixRe);
    if (match) {
      const type = match[1]!.toLowerCase() as 'lex' | 'vec' | 'hyde';
      const text = line.trimmed.slice(match[0].length).trim();
      if (!text) throw new Error(`Line ${line.number} (${type}:) must include text.`);
      if (/\r|\n/.test(text)) throw new Error(`Line ${line.number} (${type}:) contains a newline. Keep each query on a single line.`);
      typed.push({ type, query: text, line: line.number });
      continue;
    }

    if (rawLines.length === 1) return null;

    throw new Error(`Line ${line.number} is missing a lex:/vec:/hyde:/intent: prefix. Each line in a query document must start with one.`);
  }

  if (intent && typed.length === 0) {
    throw new Error('intent: cannot appear alone. Add at least one lex:, vec:, or hyde: line.');
  }

  return typed.length > 0 ? { searches: typed, intent } : null;
}

function outputResults(results: OutputRow[], query: string, opts: OutputOptions): void {
  const filtered = results.filter(r => r.score >= opts.minScore).slice(0, opts.limit);

  if (filtered.length === 0) {
    printEmptySearchResults(opts.format, "min_score");
    return;
  }

  const toQmdPath = (displayPath: string) => {
    const [collectionName, ...segments] = displayPath.split("/");
    if (!collectionName || segments.length === 0) return `qmd://${displayPath}`;
    const indexName = getActiveIndexName();
    return buildVirtualPath(collectionName, segments.join("/"), indexName === "index" ? undefined : indexName);
  };

  if (opts.format === "json") {
    const output = filtered.map(row => {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      let body = opts.full ? row.body : undefined;
      const snippetInfo = !opts.full ? extractSnippet(row.body, query, 300, row.chunkPos, undefined, opts.intent) : undefined;
      let snippet = snippetInfo?.snippet;
      if (opts.lineNumbers) {
        if (body) body = addLineNumbers(body);
        if (snippet) snippet = addLineNumbers(snippet);
      }
      return {
        ...(docid && { docid: `#${docid}` }),
        score: Math.round(row.score * 100) / 100,
        file: toQmdPath(row.displayPath),
        ...(snippetInfo && { line: snippetInfo.line }),
        title: row.title,
        ...(row.context && { context: row.context }),
        ...(body && { body }),
        ...(snippet && { snippet }),
        ...(opts.explain && row.explain && { explain: row.explain }),
      };
    });
    console.log(JSON.stringify(output, null, 2));
  } else if (opts.format === "files") {
    for (const row of filtered) {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const ctx = row.context ? `,"${row.context.replace(/"/g, '""')}"` : "";
      console.log(`#${docid},${row.score.toFixed(2)},${toQmdPath(row.displayPath)}${ctx}`);
    }
  } else if (opts.format === "cli") {
    const editorUriTemplate = getEditorUriTemplate();
    const linkDb = getDb();

    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos, undefined, opts.intent);
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);

      const virtualPath = row.file.startsWith("qmd://") ? row.file : toQmdPath(row.displayPath);
      const parsed = parseVirtualPath(virtualPath);
      const absolutePath = resolveVirtualPath(linkDb, virtualPath);

      const legacyPath = toQmdPath(row.displayPath);
      const displayPath = parsed?.path || row.displayPath;

      const snippetBody = snippet.split("\n").slice(1).join("\n").toLowerCase();
      const hasMatch = query.toLowerCase().split(/\s+/).some(t => t.length > 0 && snippetBody.includes(t));
      const lineInfo = hasMatch ? `:${line}` : "";
      const docidStr = docid ? ` ${c.dim}#${docid}${c.reset}` : "";

      if (process.stdout.isTTY && absolutePath && parsed?.path) {
        const linkLine = hasMatch ? line : 1;
        const linkTarget = buildEditorUri(editorUriTemplate, absolutePath, linkLine, 1);
        const clickable = termLink(`${displayPath}${lineInfo}`, linkTarget);
        console.log(`${c.cyan}${clickable}${c.reset}${docidStr}`);
      } else {
        console.log(`${c.cyan}${legacyPath}${c.dim}${lineInfo}${c.reset}${docidStr}`);
      }

      if (row.title) console.log(`${c.bold}Title: ${row.title}${c.reset}`);
      if (row.context) console.log(`${c.dim}Context: ${row.context}${c.reset}`);

      const score = formatScore(row.score);
      console.log(`Score: ${c.bold}${score}${c.reset}`);
      if (opts.explain && row.explain) {
        const explain = row.explain;
        const ftsScores = explain.ftsScores.length > 0
          ? explain.ftsScores.map(formatExplainNumber).join(", ")
          : "none";
        const vecScores = explain.vectorScores.length > 0
          ? explain.vectorScores.map(formatExplainNumber).join(", ")
          : "none";
        const contribSummary = explain.rrf.contributions
          .slice()
          .sort((a, b) => b.rrfContribution - a.rrfContribution)
          .slice(0, 3)
          .map(ct => `${ct.source}/${ct.queryType}#${ct.rank}:${formatExplainNumber(ct.rrfContribution)}`)
          .join(" | ");

        console.log(`${c.dim}Explain: fts=[${ftsScores}] vec=[${vecScores}]${c.reset}`);
        console.log(`${c.dim}  RRF: total=${formatExplainNumber(explain.rrf.totalScore)} base=${formatExplainNumber(explain.rrf.baseScore)} bonus=${formatExplainNumber(explain.rrf.topRankBonus)} rank=${explain.rrf.rank}${c.reset}`);
        console.log(`${c.dim}  Blend: ${Math.round(explain.rrf.weight * 100)}%*${formatExplainNumber(explain.rrf.positionScore)} + ${Math.round((1 - explain.rrf.weight) * 100)}%*${formatExplainNumber(explain.rerankScore)} = ${formatExplainNumber(explain.blendedScore)}${c.reset}`);
        if (contribSummary.length > 0) {
          console.log(`${c.dim}  Top RRF contributions: ${contribSummary}${c.reset}`);
        }
      }
      console.log();

      let displaySnippet = opts.lineNumbers ? addLineNumbers(snippet, line) : snippet;
      const highlighted = highlightTerms(displaySnippet, query);
      console.log(highlighted);

      if (i < filtered.length - 1) console.log('\n');
    }
  } else if (opts.format === "md") {
    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const heading = row.title || row.displayPath;
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos, undefined, opts.intent).snippet;
      if (opts.lineNumbers) content = addLineNumbers(content);
      const docidLine = docid ? `**docid:** \`#${docid}\`\n` : "";
      const contextLine = row.context ? `**context:** ${row.context}\n` : "";
      console.log(`---\n# ${heading}\n${docidLine}${contextLine}\n${content}\n`);
    }
  } else if (opts.format === "xml") {
    for (const row of filtered) {
      const titleAttr = row.title ? ` title="${row.title.replace(/"/g, '&quot;')}"` : "";
      const contextAttr = row.context ? ` context="${row.context.replace(/"/g, '&quot;')}"` : "";
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos, undefined, opts.intent).snippet;
      if (opts.lineNumbers) content = addLineNumbers(content);
      console.log(`<file docid="#${docid}" name="${toQmdPath(row.displayPath)}"${titleAttr}${contextAttr}>\n${content}\n</file>\n`);
    }
  } else {
    // CSV format
    console.log("docid,score,file,title,context,line,snippet");
    for (const row of filtered) {
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos, undefined, opts.intent);
      let content = opts.full ? row.body : snippet;
      if (opts.lineNumbers) content = addLineNumbers(content, line);
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      console.log(`#${docid},${row.score.toFixed(4)},${escapeCSV(toQmdPath(row.displayPath))},${escapeCSV(row.title || "")},${escapeCSV(row.context || "")},${line},${escapeCSV(content || "")}`);
    }
  }
}

function logExpansionTree(originalQuery: string, expanded: ExpandedQuery[]): void {
  const lines: string[] = [];
  lines.push(`${c.dim}├─ ${originalQuery}${c.reset}`);
  for (const q of expanded) {
    let preview = q.query.replace(/\n/g, ' ');
    if (preview.length > 72) preview = preview.substring(0, 69) + '...';
    lines.push(`${c.dim}├─ ${q.type}: ${preview}${c.reset}`);
  }
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace('├─', '└─');
  }
  for (const line of lines) process.stderr.write(line + '\n');
}

export function search(query: string, opts: OutputOptions): void {
  const db = getDb();
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;
  const fetchLimit = opts.all ? 100000 : Math.max(50, opts.limit * 2);
  const results = filterByCollections(
    searchFTS(db, query, fetchLimit, singleCollection),
    collectionNames
  );

  const resultsWithContext = results.map(r => ({
    file: r.filepath,
    displayPath: r.displayPath,
    title: r.title,
    body: r.body || "",
    score: r.score,
    context: getContextForFile(db, r.filepath),
    hash: r.hash,
    docid: r.docid,
  }));

  closeDb();

  if (resultsWithContext.length === 0) {
    printEmptySearchResults(opts.format);
    return;
  }
  outputResults(resultsWithContext, query, opts);
}

export async function vectorSearch(query: string, opts: OutputOptions, _model: string = DEFAULT_EMBED_MODEL): Promise<void> {
  const store = getStore();
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  checkIndexHealth(store.db, opts.quiet);

  await withLLMSession(async () => {
    let results = await vectorSearchQuery(store, query, {
      collection: singleCollection,
      limit: opts.all ? 500 : (opts.limit || 10),
      minScore: opts.minScore || 0.3,
      intent: opts.intent,
      hooks: {
        onExpand: (original, expanded) => {
          if (!opts.quiet) {
            logExpansionTree(original, expanded);
            process.stderr.write(`${c.dim}Searching ${expanded.length + 1} vector queries...${c.reset}\n`);
          }
        },
      },
    });

    if (collectionNames.length > 1) {
      results = results.filter(r => {
        const prefixes = collectionNames.map(n => `qmd://${n}/`);
        return prefixes.some(p => r.file.startsWith(p));
      });
    }

    closeDb();

    if (results.length === 0) {
      printEmptySearchResults(opts.format);
      return;
    }

    outputResults(results.map(r => ({
      file: r.file,
      displayPath: r.displayPath,
      title: r.title,
      body: r.body,
      score: r.score,
      context: r.context,
      docid: r.docid,
    })), query, { ...opts, limit: results.length });
  }, { maxDuration: 10 * 60 * 1000, name: 'vectorSearch' });
}

export async function querySearch(query: string, opts: OutputOptions, _embedModel: string = DEFAULT_EMBED_MODEL, _rerankModel: string = DEFAULT_RERANK_MODEL): Promise<void> {
  const store = getStore();
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  checkIndexHealth(store.db, opts.quiet);

  const parsed = parseStructuredQuery(query);
  const intent = opts.intent || parsed?.intent;

  await withLLMSession(async () => {
    let results;

    const log = (msg: string) => { if (!opts.quiet) process.stderr.write(msg); };

    if (parsed) {
      const structuredQueries = parsed.searches;
      const typeLabels = structuredQueries.map(s => s.type).join('+');
      log(`${c.dim}Structured search: ${structuredQueries.length} queries (${typeLabels})${c.reset}\n`);
      if (intent) {
        log(`${c.dim}├─ intent: ${intent}${c.reset}\n`);
      }

      if (!opts.quiet) {
        for (const s of structuredQueries) {
          let preview = s.query.replace(/\n/g, ' ');
          if (preview.length > 72) preview = preview.substring(0, 69) + '...';
          process.stderr.write(`${c.dim}├─ ${s.type}: ${preview}${c.reset}\n`);
        }
        process.stderr.write(`${c.dim}└─ Searching...${c.reset}\n`);
      }

      results = await structuredSearch(store, structuredQueries, {
        collections: singleCollection ? [singleCollection] : undefined,
        limit: opts.all ? 500 : (opts.limit || 10),
        minScore: opts.minScore || 0,
        candidateLimit: opts.candidateLimit,
        skipRerank: opts.skipRerank,
        explain: !!opts.explain,
        intent,
        chunkStrategy: opts.chunkStrategy,
        hooks: {
          onEmbedStart: (count) => {
            log(`${c.dim}Embedding ${count} ${count === 1 ? 'query' : 'queries'}...${c.reset}`);
          },
          onEmbedDone: (ms) => {
            log(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
          },
          onRerankStart: (chunkCount) => {
            log(`${c.dim}Reranking ${chunkCount} chunks...${c.reset}`);
            if (!opts.quiet) progress.indeterminate();
          },
          onRerankDone: (ms) => {
            if (!opts.quiet) progress.clear();
            log(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
          },
        },
      });
    } else {
      results = await hybridQuery(store, query, {
        collection: singleCollection,
        limit: opts.all ? 500 : (opts.limit || 10),
        minScore: opts.minScore || 0,
        candidateLimit: opts.candidateLimit,
        skipRerank: opts.skipRerank,
        explain: !!opts.explain,
        intent,
        chunkStrategy: opts.chunkStrategy,
        hooks: {
          onStrongSignal: (score) => {
            log(`${c.dim}Strong BM25 signal (${score.toFixed(2)}) — skipping expansion${c.reset}\n`);
          },
          onExpandStart: () => {
            log(`${c.dim}Expanding query...${c.reset}`);
          },
          onExpand: (original, expanded, ms) => {
            log(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
            if (!opts.quiet) logExpansionTree(original, expanded);
            log(`${c.dim}Searching ${expanded.length + 1} queries...${c.reset}\n`);
          },
          onEmbedStart: (count) => {
            log(`${c.dim}Embedding ${count} ${count === 1 ? 'query' : 'queries'}...${c.reset}`);
          },
          onEmbedDone: (ms) => {
            log(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
          },
          onRerankStart: (chunkCount) => {
            log(`${c.dim}Reranking ${chunkCount} chunks...${c.reset}`);
            if (!opts.quiet) progress.indeterminate();
          },
          onRerankDone: (ms) => {
            if (!opts.quiet) progress.clear();
            log(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
          },
        },
      });
    }

    if (collectionNames.length > 1) {
      results = results.filter(r => {
        const prefixes = collectionNames.map(n => `qmd://${n}/`);
        return prefixes.some(p => r.file.startsWith(p));
      });
    }

    closeDb();

    if (results.length === 0) {
      printEmptySearchResults(opts.format);
      return;
    }

    const structuredQueries = parsed?.searches;
    const displayQuery = structuredQueries
      ? (structuredQueries.find(s => s.type === 'lex')?.query || structuredQueries.find(s => s.type === 'vec')?.query || query)
      : query;

    outputResults(results.map(r => ({
      file: r.file,
      displayPath: r.displayPath,
      title: r.title,
      body: r.bestChunk,
      chunkPos: r.bestChunkPos,
      score: r.score,
      context: r.context,
      docid: r.docid,
      explain: r.explain,
    })), displayQuery, { ...opts, limit: results.length });
  }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' });
}

export function filterSearch(filterExpr: string, opts: OutputOptions): void {
  const db = getDb();
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;
  const limit = opts.all ? undefined : opts.limit;

  let results: FindResult[];
  try {
    results = findByFilter(db, filterExpr, { collection: singleCollection, limit: limit ?? 50 });
  } catch (err) {
    console.error(`Filter error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  closeDb();

  if (results.length === 0) {
    printEmptySearchResults(opts.format);
    return;
  }

  if (opts.format === "json") {
    console.log(JSON.stringify(results.map(r => ({
      file: `qmd://${r.collection}/${r.path}`,
      title: r.title,
      modified: r.modified_at?.slice(0, 10) ?? null,
      word_count: r.word_count,
    })), null, 2));
    return;
  }
  if (opts.format === "files") {
    for (const r of results) console.log(`qmd://${r.collection}/${r.path}`);
    return;
  }
  if (opts.format === "csv") {
    console.log("file,title,modified,word_count");
    for (const r of results) {
      console.log(`${escapeCSV(`qmd://${r.collection}/${r.path}`)},${escapeCSV(r.title)},${r.modified_at?.slice(0, 10) ?? ""},${r.word_count}`);
    }
    return;
  }
  if (opts.format === "md") {
    console.log(`| File | Title | Modified | Words |`);
    console.log(`|------|-------|----------|-------|`);
    for (const r of results) {
      console.log(`| qmd://${r.collection}/${r.path} | ${r.title} | ${r.modified_at?.slice(0, 10) ?? ""} | ${r.word_count} |`);
    }
    return;
  }
  console.log(`Found ${results.length} document(s):\n`);
  for (const r of results) {
    const modified = r.modified_at?.slice(0, 10) ?? "?";
    const words = r.word_count ? ` (${r.word_count}w)` : "";
    console.log(`  ${c.bold}${r.collection}/${r.path}${c.reset}${words}  ${c.dim}${modified}${c.reset}`);
    if (r.title) console.log(`  ${r.title}`);
    console.log();
  }
}
