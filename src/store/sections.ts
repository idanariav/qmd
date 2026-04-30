// Layer 0: AST-based section extraction

import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Heading, Root } from "mdast";
import type { SectionFilter } from "../collections.js";

function headingText(node: Heading): string {
  return node.children
    .map((child) => {
      if ("value" in child) return child.value;
      if ("children" in child) return headingText(child as unknown as Heading);
      return "";
    })
    .join("");
}

/**
 * Extract content under a specific heading using AST-based parsing.
 *
 * Finds the heading matching the given name and level, and returns
 * all content between it and the next heading of same-or-higher level,
 * or end of document. Headings inside code blocks are correctly ignored
 * by the remark parser.
 *
 * Returns the original text (preserving formatting) via position offsets,
 * or null if the heading is not found.
 */
export function extractSectionByHeading(
  text: string,
  sectionFilter: SectionFilter
): string | null {
  const tree: Root = unified().use(remarkParse).parse(text);

  let sectionStart: number | null = null;
  let sectionEnd: number | null = null;

  for (const node of tree.children) {
    if (node.type !== "heading") continue;
    const heading = node as Heading;

    if (sectionStart !== null) {
      if (heading.depth <= sectionFilter.level) {
        sectionEnd = heading.position!.start.offset!;
        break;
      }
    } else if (
      heading.depth === sectionFilter.level &&
      headingText(heading).trim() === sectionFilter.heading
    ) {
      sectionStart = heading.position!.end.offset!;
    }
  }

  if (sectionStart === null) return null;
  if (sectionEnd === null) sectionEnd = text.length;

  const content = text.substring(sectionStart, sectionEnd).trim();
  return content || null;
}
