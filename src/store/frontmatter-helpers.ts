// Layer 0: frontmatter extraction helpers shared by chunking and documents

import { createRequire } from "node:module";
import YAML from "yaml";

const require = createRequire(import.meta.url);
const grayMatter = require("gray-matter") as typeof import("gray-matter");
const PLUS_FRONTMATTER_OPTIONS = { delimiters: "+++" } as const;

export interface FrontmatterInfo {
  raw: string;
  body: string;
  matter: string;
  data: Record<string, unknown> | null;
  language: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFrontmatterData(raw: string): Record<string, unknown> | null {
  for (const parser of [() => YAML.parse(raw) as unknown, () => JSON.parse(raw) as unknown]) {
    try {
      const parsed = parser();
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next parser.
    }
  }
  return null;
}

function extractFrontmatterWithOptions(content: string, options?: { delimiters: string }): FrontmatterInfo | null {
  if (!grayMatter.test(content, options)) return null;

  try {
    const parsed = grayMatter(content, options);
    const rawLength = content.length - parsed.content.length;
    if (rawLength <= 0) return null;

    return {
      raw: content.slice(0, rawLength),
      body: parsed.content,
      matter: parsed.matter,
      data: isRecord(parsed.data) ? parsed.data : parseFrontmatterData(parsed.matter),
      language: parsed.language || null,
    };
  } catch {
    return null;
  }
}

function extractFrontmatterByDelimiter(content: string): FrontmatterInfo | null {
  const patterns = [
    /^(?:﻿)?---[^\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/,
    /^(?:﻿)?\+\+\+[^\r\n]*\r?\n([\s\S]*?)\r?\n\+\+\+[^\S\r\n]*(?:\r?\n|$)/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (!match) continue;

    const raw = match[0];
    const matter = match[1] ?? "";
    return {
      raw,
      body: content.slice(raw.length),
      matter,
      data: parseFrontmatterData(matter),
      language: null,
    };
  }

  return null;
}

export function extractFrontmatter(content: string): FrontmatterInfo | null {
  return extractFrontmatterWithOptions(content)
    ?? extractFrontmatterWithOptions(content, PLUS_FRONTMATTER_OPTIONS)
    ?? extractFrontmatterByDelimiter(content);
}
