// CLI argument parsing — parseCLI, normalizeArgv, OutputOptions type

import { parseArgs } from "util";
import type { OutputFormat } from "./formatter.js";
import type { ChunkStrategy, HybridQueryExplain } from "../store.js";
import type { ExpandedQuery } from "../store.js";
import { setIndexName } from "./store-access.js";
import { setConfigIndexName } from "../collections.js";
import { parseChunkStrategy } from "./utils.js";

export type OutputOptions = {
  format: OutputFormat;
  full: boolean;
  limit: number;
  minScore: number;
  all?: boolean;
  collection?: string | string[];
  lineNumbers?: boolean;
  explain?: boolean;
  context?: string;
  candidateLimit?: number;
  intent?: string;
  skipRerank?: boolean;
  chunkStrategy?: ChunkStrategy;
  quiet?: boolean;
};

export type OutputRow = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context?: string | null;
  chunkPos?: number;
  hash?: string;
  docid?: string;
  explain?: HybridQueryExplain;
};

export type EmptySearchReason = "no_results" | "min_score";

export interface ParsedStructuredQuery {
  searches: ExpandedQuery[];
  intent?: string;
}

export function normalizeArgv(argv: string[]): string[] {
  return argv.map(arg => {
    if (!arg.startsWith('--')) return arg;
    const eqIdx = arg.indexOf('=');
    const flag = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
    const rest = eqIdx === -1 ? '' : arg.slice(eqIdx);
    const kebab = flag.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    return kebab === flag ? arg : `--${kebab}${rest}`;
  });
}

export function parseCLI() {
  const { values, positionals } = parseArgs({
    args: normalizeArgv(process.argv.slice(2)),
    options: {
      index: { type: "string" },
      context: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      skill: { type: "boolean" },
      global: { type: "boolean" },
      yes: { type: "boolean" },
      n: { type: "string" },
      "min-score": { type: "string" },
      all: { type: "boolean" },
      full: { type: "boolean" },
      csv: { type: "boolean" },
      md: { type: "boolean" },
      xml: { type: "boolean" },
      files: { type: "boolean" },
      json: { type: "boolean" },
      explain: { type: "boolean" },
      collection: { type: "string", short: "c", multiple: true },
      name: { type: "string" },
      mask: { type: "string" },
      "heading-name": { type: "string" },
      "heading-level": { type: "string" },
      force: { type: "boolean", short: "f" },
      "max-docs-per-batch": { type: "string" },
      "max-batch-mb": { type: "string" },
      pull: { type: "boolean" },
      refresh: { type: "boolean" },
      l: { type: "string" },
      from: { type: "string" },
      "max-bytes": { type: "string" },
      "line-numbers": { type: "boolean" },
      "no-callouts": { type: "boolean" },
      "no-codeblocks": { type: "boolean" },
      section: { type: "string" },
      quiet: { type: "boolean", short: "q" },
      "candidate-limit": { type: "string", short: "C" },
      "no-rerank": { type: "boolean", default: false },
      intent: { type: "string" },
      "chunk-strategy": { type: "string" },
      http: { type: "boolean" },
      daemon: { type: "boolean" },
      port: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const indexName = values.index as string | undefined;
  if (indexName) {
    setIndexName(indexName);
    setConfigIndexName(indexName);
  }

  let format: OutputFormat = "cli";
  if (values.csv) format = "csv";
  else if (values.md) format = "md";
  else if (values.xml) format = "xml";
  else if (values.files) format = "files";
  else if (values.json) format = "json";

  const defaultLimit = (format === "files" || format === "json") ? 20 : 5;
  const isAll = !!values.all;

  const opts: OutputOptions = {
    format,
    full: !!values.full,
    limit: isAll ? 100000 : (values.n ? parseInt(String(values.n), 10) || defaultLimit : defaultLimit),
    minScore: values["min-score"] ? parseFloat(String(values["min-score"])) || 0 : 0,
    all: isAll,
    collection: values.collection as string[] | undefined,
    lineNumbers: !!values["line-numbers"],
    candidateLimit: values["candidate-limit"] ? parseInt(String(values["candidate-limit"]), 10) : undefined,
    skipRerank: !!values["no-rerank"],
    explain: !!values.explain,
    intent: values.intent as string | undefined,
    chunkStrategy: parseChunkStrategy(values["chunk-strategy"]),
    quiet: !!values.quiet || ["json", "csv", "xml", "files"].includes(format),
  };

  return {
    command: positionals[0] || "",
    args: positionals.slice(1),
    query: positionals.slice(1).join(" "),
    opts,
    values,
  };
}
