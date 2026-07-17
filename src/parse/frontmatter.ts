import matter from "gray-matter";

export interface FrontmatterValue {
  key: string;
  value_text: string;
  value_num: number | null;
  value_date: string | null;
  is_array: boolean;
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  rows: FrontmatterValue[];
  tags: string[];
  createdDate: string | null;
  modifiedDate: string | null;
  title: string | null;
}

const DATE_FIELDS = new Set(["created", "date", "created_at", "dateCreated"]);
const MODIFIED_FIELDS = new Set(["modified", "updated", "modified_at", "dateModified", "lastModified"]);
const TAG_FIELDS = new Set(["tags", "tag"]);
const TITLE_FIELDS = new Set(["title", "name"]);

function toISODate(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val.toISOString().slice(0, 10);
  if (typeof val === "string") {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

function scalarText(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val);
}

function parseValue(key: string, val: unknown): FrontmatterValue[] {
  if (Array.isArray(val)) {
    return val.map((item) => ({
      key,
      value_text: scalarText(item),
      value_num: typeof item === "number" ? item : null,
      value_date: toISODate(item),
      is_array: true,
    }));
  }
  return [{
    key,
    value_text: scalarText(val),
    value_num: typeof val === "number" ? val : null,
    value_date: toISODate(val),
    is_array: false,
  }];
}

function extractStringList(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  if (typeof val === "string") return val.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

/** Try each field name in order, returning the first one `extract` resolves to a non-null value. */
function firstMatch<T>(
  fields: Iterable<string>,
  data: Record<string, unknown>,
  extract: (raw: unknown) => T | null
): T | null {
  for (const field of fields) {
    const value = extract(data[field]);
    if (value !== null) return value;
  }
  return null;
}

export function parseFrontmatter(fileContent: string): ParsedFrontmatter {
  let data: Record<string, unknown> = {};
  let body = fileContent;

  try {
    const parsed = matter(fileContent);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // Malformed front matter — treat whole file as body
  }

  const rows: FrontmatterValue[] = [];
  for (const [key, val] of Object.entries(data)) {
    rows.push(...parseValue(key, val));
  }

  const tags = firstMatch(TAG_FIELDS, data, (raw) => raw !== undefined ? extractStringList(raw) : null) ?? [];
  const createdDate = firstMatch(DATE_FIELDS, data, toISODate);
  const modifiedDate = firstMatch(MODIFIED_FIELDS, data, toISODate);
  const title = firstMatch(TITLE_FIELDS, data, (raw) => typeof raw === "string" && raw ? raw : null);

  return { data, body, rows, tags, createdDate, modifiedDate, title };
}
