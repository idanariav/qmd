// Layer 2: Document "profiles" — searchable frontmatter text (aliases, description).
//
// Chunk vectors/FTS only see the document body, which for atomic notes misses the densest
// summary: the aliases and description. A profile adds that text to FTS (own columns) and
// embeds `title + aliases + description` as one extra vector per document.

import { createHash } from "crypto";
import type { Database } from "../db.js";
import type { ParsedFrontmatter } from "../parse/frontmatter.js";

const ALIAS_KEYS = new Set(["aliases", "alias"]);
const DESCRIPTION_KEYS = new Set(["description", "summary"]);

/** Prefix of the `vectors_vec.hash_seq` key for profile vectors (chunk keys are `<hash>_<seq>`). */
export const PROFILE_KEY_PREFIX = "profile:";

export const profileKey = (docId: number): string => `${PROFILE_KEY_PREFIX}${docId}`;

export type ProfileFields = { aliases: string; description: string };

export function extractProfileFields(fm: Pick<ParsedFrontmatter, "rows">): ProfileFields {
  const aliases: string[] = [];
  let description = "";
  for (const row of fm.rows) {
    const key = row.key.toLowerCase();
    const value = row.value_text?.trim();
    if (!value) continue;
    if (ALIAS_KEYS.has(key)) aliases.push(value);
    else if (DESCRIPTION_KEYS.has(key) && !description) description = value;
  }
  return { aliases: aliases.join(", "), description };
}

/** Text embedded for a profile (the `text` half of the doc-embedding format), or null if there is nothing beyond the title. */
export function buildProfileText(fields: ProfileFields): string | null {
  const text = [fields.aliases, fields.description].filter(Boolean).join(". ");
  return text ? text : null;
}

export function profileHash(title: string, text: string): string {
  return createHash("sha256").update(`${title}\n${text}`).digest("hex");
}

/** Store a document's profile fields and refresh its FTS row (the document triggers don't see frontmatter-only changes). */
export function upsertDocProfile(db: Database, docId: number, fields: ProfileFields): void {
  db.prepare(`
    INSERT INTO doc_profiles (doc_id, aliases, description) VALUES (?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET aliases = excluded.aliases, description = excluded.description
  `).run(docId, fields.aliases, fields.description);
  db.prepare(`UPDATE documents_fts SET aliases = ?, description = ? WHERE rowid = ?`)
    .run(fields.aliases, fields.description, docId);
}

export type ProfileToEmbed = { docId: number; title: string; text: string; hash: string };

/** Active documents whose profile text is new or changed since it was last embedded (or embedded with another model). */
export function getProfilesNeedingEmbedding(db: Database, model: string, collection?: string): ProfileToEmbed[] {
  const rows = db.prepare(`
    SELECT d.id AS docId, d.title, p.aliases, p.description, p.embedded_hash, p.model
    FROM doc_profiles p JOIN documents d ON d.id = p.doc_id
    WHERE d.active = 1 ${collection ? "AND d.collection = ?" : ""}
  `).all(...(collection ? [collection] : [])) as {
    docId: number; title: string; aliases: string; description: string; embedded_hash: string | null; model: string | null;
  }[];
  const out: ProfileToEmbed[] = [];
  for (const r of rows) {
    const text = buildProfileText(r);
    if (!text) continue;
    const hash = profileHash(r.title, text);
    if (r.embedded_hash !== hash || r.model !== model) out.push({ docId: r.docId, title: r.title, text, hash });
  }
  return out;
}

export function insertProfileEmbedding(
  db: Database, profile: ProfileToEmbed, embedding: Float32Array, model: string, embeddedAt: string
): void {
  const key = profileKey(profile.docId);
  db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(key);
  db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(key, embedding);
  db.prepare(`UPDATE doc_profiles SET embedded_hash = ?, model = ?, embedded_at = ? WHERE doc_id = ?`)
    .run(profile.hash, model, embeddedAt, profile.docId);
}
