// Layer 2: Smart chunking — break point detection and chunk algorithms

import { CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS, CHUNK_WINDOW_CHARS } from "./config.js";
import { extractFrontmatter } from "./frontmatter-helpers.js";
import { HTML_ELEMENTS } from "../html-elements.js";

export interface BreakPoint {
  pos: number;
  score: number;
  type: string;
}

export interface ProtectedRegion {
  start: number;
  end: number;
  kind?: string;
}

export const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/\n#{1}(?!#)/g, 100, 'h1'],
  [/\n#{2}(?!#)/g, 90, 'h2'],
  [/\n#{3}(?!#)/g, 80, 'h3'],
  [/\n#{4}(?!#)/g, 70, 'h4'],
  [/\n#{5}(?!#)/g, 60, 'h5'],
  [/\n#{6}(?!#)/g, 50, 'h6'],
  [/\n(?:`{3,}|~{3,})/g, 80, 'codeblock'],
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60, 'hr'],
  [/\n\n+/g, 20, 'blank'],
  [/\n/g, 1, 'newline'],
];

export function scanBreakPoints(text: string): BreakPoint[] {
  const points: BreakPoint[] = [];
  const seen = new Map<number, BreakPoint>();

  for (const [pattern, score, type] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index!;
      const existing = seen.get(pos);
      if (!existing || score > existing.score) {
        seen.set(pos, { pos, score, type });
      }
    }
  }

  for (const bp of seen.values()) {
    points.push(bp);
  }
  return points.sort((a, b) => a.pos - b.pos);
}

export function findCodeFences(text: string): ProtectedRegion[] {
  const regions: ProtectedRegion[] = [];
  const fencePattern = /\n(`{3,}|~{3,})([^\n]*)/g;
  let open: { char: string; len: number; start: number } | null = null;

  for (const match of text.matchAll(fencePattern)) {
    const run = match[1]!;
    const tail = match[2]!;
    const char = run[0]!;
    const len = run.length;
    const pos = match.index!;

    if (!open) {
      open = { char, len, start: pos };
      continue;
    }

    if (char === open.char && len >= open.len && tail.trim() === '') {
      regions.push({ start: open.start, end: pos + match[0].length, kind: 'fence' });
      open = null;
    }
  }

  if (open) {
    regions.push({ start: open.start, end: text.length, kind: 'fence' });
  }

  return regions;
}

export function isInsideProtectedRegion(pos: number, regions: ProtectedRegion[]): boolean {
  return regions.some(r => pos > r.start && pos < r.end);
}

interface ListFrame {
  indent: number;
  contentCol: number;
}

export function findListBreakPoints(text: string): BreakPoint[] {
  const points: BreakPoint[] = [];
  if (text.length === 0) return points;

  const itemScores = [70, 45, 25];
  const itemTypes = ['list-item-0', 'list-item-1', 'list-item-2'];
  const scoreFor = (depth: number): number =>
    depth < itemScores.length ? itemScores[depth]! : itemScores[itemScores.length - 1]!;
  const typeFor = (depth: number): string =>
    depth < itemTypes.length ? itemTypes[depth]! : itemTypes[itemTypes.length - 1]!;

  const stack: ListFrame[] = [];
  let lineStart = 0;
  const n = text.length;
  const itemRegex = /^( *)(?:([-*])|(\d+)([.)]))( +)/;

  while (lineStart <= n) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = n;
    const line = text.slice(lineStart, lineEnd);
    const bpPos = lineStart === 0 ? 0 : lineStart - 1;

    const isBlank = line.trim().length === 0;

    if (isBlank) {
      if (lineEnd === n) break;
      lineStart = lineEnd + 1;
      continue;
    }

    const match = itemRegex.exec(line);
    if (match) {
      const leading = match[1]!;
      const indent = leading.length;
      const bullet = match[2];
      const digits = match[3];
      const ordPunct = match[4];
      const spaces = match[5]!;
      const markerLen = bullet ? 1 : (digits!.length + ordPunct!.length);
      const contentCol = indent + markerLen + spaces.length;

      while (stack.length > 0 && indent < stack[stack.length - 1]!.indent) {
        stack.pop();
      }

      let depth: number;
      if (stack.length === 0) {
        stack.push({ indent, contentCol });
        depth = 0;
      } else {
        const top = stack[stack.length - 1]!;
        if (indent >= top.contentCol) {
          stack.push({ indent, contentCol });
          depth = stack.length - 1;
        } else {
          depth = stack.length - 1;
        }
      }

      if (lineStart > 0) {
        points.push({ pos: bpPos, score: scoreFor(depth), type: typeFor(depth) });
      }
    } else {
      if (stack.length > 0) {
        const indent = line.length - line.trimStart().length;
        const bottom = stack[0]!;
        if (indent >= bottom.contentCol) {
          // Continuation of outermost item; keep state.
        } else {
          stack.length = 0;
          points.push({ pos: bpPos, score: 75, type: 'list-end' });
        }
      }
    }

    if (lineEnd === n) break;
    lineStart = lineEnd + 1;
  }

  if (stack.length > 0) {
    points.push({ pos: n, score: 75, type: 'list-end' });
  }

  return points.sort((a, b) => a.pos - b.pos);
}

export function findXmlTagBreakPoints(text: string, fences: ProtectedRegion[]): BreakPoint[] {
  const NAME = '[A-Za-z_][A-Za-z0-9_.:-]*';
  const openRe = new RegExp(`^\\s*<(${NAME})(?:\\s+[^>]*)?>\\s*$`);
  const closeRe = new RegExp(`^\\s*</(${NAME})\\s*>\\s*$`);
  const selfCloseRe = new RegExp(`^\\s*<(${NAME})(?:\\s+[^>]*)?/>\\s*$`);
  const commentRe = /^\s*<!--.*-->\s*$/;
  const doctypeRe = /^\s*<!DOCTYPE\b[^>]*>\s*$/i;
  const cdataRe = /^\s*<!\[CDATA\[.*\]\]>\s*$/;
  const piRe = /^\s*<\?[\s\S]*\?>\s*$/;

  interface Frame {
    name: string;
    checkpoint: number;
  }

  const stack: Frame[] = [];
  const pending: BreakPoint[] = [];
  const output: BreakPoint[] = [];

  const commit = () => {
    if (stack.length === 0) {
      for (const bp of pending) output.push(bp);
      pending.length = 0;
    }
  };

  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);

    const insideFence = fences.some(r => lineStart > r.start && lineStart < r.end);
    if (insideFence) {
      if (lineEnd === text.length) break;
      lineStart = lineEnd + 1;
      continue;
    }

    if (commentRe.test(line) || doctypeRe.test(line) || cdataRe.test(line) || piRe.test(line)) {
      if (lineEnd === text.length) break;
      lineStart = lineEnd + 1;
      continue;
    }

    if (selfCloseRe.test(line)) {
      if (lineEnd === text.length) break;
      lineStart = lineEnd + 1;
      continue;
    }

    const openMatch = line.match(openRe);
    if (openMatch) {
      const name = openMatch[1]!;
      if (!HTML_ELEMENTS.has(name.toLowerCase())) {
        const frame: Frame = { name, checkpoint: pending.length };
        stack.push(frame);
        if (lineStart > 0) {
          pending.push({ pos: lineStart - 1, score: 30, type: 'tag-open' });
        }
      }
      if (lineEnd === text.length) break;
      lineStart = lineEnd + 1;
      continue;
    }

    const closeMatch = line.match(closeRe);
    if (closeMatch) {
      const name = closeMatch[1]!;
      if (!HTML_ELEMENTS.has(name.toLowerCase())) {
        if (stack.length === 0) {
          // Stray closing tag — ignore.
        } else {
          const top = stack[stack.length - 1]!;
          if (top.name === name) {
            if (lineStart > 0) {
              pending.push({ pos: lineStart - 1, score: 75, type: 'tag-close' });
            }
            stack.pop();
            commit();
          } else {
            pending.length = 0;
            stack.length = 0;
          }
        }
      }
      if (lineEnd === text.length) break;
      lineStart = lineEnd + 1;
      continue;
    }

    if (lineEnd === text.length) break;
    lineStart = lineEnd + 1;
  }

  return output.sort((a, b) => a.pos - b.pos);
}

export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars: number = CHUNK_WINDOW_CHARS,
  decayFactor: number = 0.7,
  protectedRegions: ProtectedRegion[] = []
): number {
  const windowStart = targetCharPos - windowChars;
  let bestScore = -1;
  let bestPos = targetCharPos;

  for (const bp of breakPoints) {
    if (bp.pos < windowStart) continue;
    if (bp.pos > targetCharPos) break;

    if (isInsideProtectedRegion(bp.pos, protectedRegions)) continue;

    const distance = targetCharPos - bp.pos;
    const normalizedDist = distance / windowChars;
    const multiplier = 1.0 - (normalizedDist * normalizedDist) * decayFactor;
    const finalScore = bp.score * multiplier;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestPos = bp.pos;
    }
  }

  return bestPos;
}

export type ChunkStrategy = "auto" | "regex";

export function mergeBreakPoints(a: BreakPoint[], b: BreakPoint[]): BreakPoint[] {
  const seen = new Map<number, BreakPoint>();
  for (const bp of a) {
    const existing = seen.get(bp.pos);
    if (!existing || bp.score > existing.score) {
      seen.set(bp.pos, bp);
    }
  }
  for (const bp of b) {
    const existing = seen.get(bp.pos);
    if (!existing || bp.score > existing.score) {
      seen.set(bp.pos, bp);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.pos - b.pos);
}

function chunkDocumentCore(
  content: string,
  breakPoints: BreakPoint[],
  protectedRegions: ProtectedRegion[],
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }];
  }

  const chunks: { text: string; pos: number }[] = [];
  let charPos = 0;

  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length);
    let endPos = targetEndPos;

    if (endPos < content.length) {
      const bestCutoff = findBestCutoff(
        breakPoints,
        targetEndPos,
        windowChars,
        0.7,
        protectedRegions
      );

      if (bestCutoff > charPos && bestCutoff <= targetEndPos) {
        endPos = bestCutoff;
      }
    }

    if (endPos <= charPos) {
      endPos = Math.min(charPos + maxChars, content.length);
    }

    chunks.push({ text: content.slice(charPos, endPos), pos: charPos });

    if (endPos >= content.length) {
      break;
    }
    charPos = endPos - overlapChars;
    const lastChunkPos = chunks.at(-1)!.pos;
    if (charPos <= lastChunkPos) {
      charPos = endPos;
    }
  }

  return chunks;
}

export function chunkDocumentWithBreakPoints(
  content: string,
  breakPoints: BreakPoint[],
  codeFences: ProtectedRegion[],
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return chunkDocumentCore(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
  }

  if (frontmatter.raw.length >= content.length) {
    return [{ text: content, pos: 0 }];
  }

  const offset = frontmatter.raw.length;
  const bodyBreakPoints = breakPoints
    .filter(bp => bp.pos >= offset)
    .map(bp => ({ ...bp, pos: bp.pos - offset }));
  const bodyCodeFences = codeFences
    .filter(fence => fence.end > offset)
    .map(fence => ({
      start: Math.max(0, fence.start - offset),
      end: Math.max(0, fence.end - offset),
    }))
    .filter(fence => fence.end > 0);
  const bodyChunks = chunkDocumentCore(
    frontmatter.body,
    bodyBreakPoints,
    bodyCodeFences,
    maxChars,
    overlapChars,
    windowChars,
  ).map(chunk => ({ text: chunk.text, pos: chunk.pos + offset }));

  return [{ text: frontmatter.raw, pos: 0 }, ...bodyChunks];
}
