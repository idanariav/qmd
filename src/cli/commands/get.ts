// Commands: getDocument (qmd get), multiGet (qmd multi-get), listFiles (qmd ls)

import { existsSync, readFileSync } from "fs";
import {
  getPwd,
  getRealPath,
  homedir,
  resolve,
  isVirtualPath,
  parseVirtualPath,
  buildVirtualPath,
  isDocid,
  findDocumentByDocid,
  matchFilesByGlob,
  handelize,
  getContextForPath,
  resolveRawContent,
  addLineNumbers,
  extractSectionByHeading,
  findCodeFences,
  DEFAULT_MULTI_GET_MAX_BYTES,
} from "../../store.js";
import { parseFrontmatter } from "../../parse/frontmatter.js";
import { parseStructure } from "../../parse/structure.js";
import {
  getCollection as getCollectionFromYaml,
  listCollections as yamlListCollections,
  setConfigIndexName,
} from "../../collections.js";
import { escapeXml } from "../formatter.js";
import { getDb, closeDb, setIndexName } from "../store-access.js";
import { c, formatBytes } from "../utils.js";
import { detectCollectionFromPath } from "./context.js";
import type { OutputFormat } from "../formatter.js";

interface GetDocumentOptions {
  fromLine?: number;
  maxLines?: number;
  lineNumbers?: boolean;
  section?: string;
  stripCallouts?: boolean;
  noCodeblocks?: boolean;
}

export function getDocument(filename: string, opts: GetDocumentOptions = {}): void {
  let { fromLine, maxLines, lineNumbers, section, stripCallouts, noCodeblocks } = opts;
  let inputPath = filename;
  const colonMatch = inputPath.match(/:(\d+)$/);
  if (colonMatch && !fromLine) {
    const matched = colonMatch[1];
    if (matched) {
      fromLine = parseInt(matched, 10);
      inputPath = inputPath.slice(0, -colonMatch[0].length);
    }
  }

  const parsedIndexPath = isVirtualPath(inputPath) ? parseVirtualPath(inputPath) : null;
  if (parsedIndexPath?.indexName) {
    setIndexName(parsedIndexPath.indexName);
    setConfigIndexName(parsedIndexPath.indexName);
  }

  const db = getDb();

  if (isDocid(inputPath)) {
    const docidMatch = findDocumentByDocid(db, inputPath);
    if (docidMatch) {
      inputPath = docidMatch.filepath;
    } else {
      console.error(`Document not found: ${filename}`);
      closeDb();
      process.exit(1);
    }
  }

  let doc: { collectionName: string; path: string; originalPath: string | null; body: string } | null = null;
  let virtualPath: string;

  if (isVirtualPath(inputPath)) {
    const parsed = parseVirtualPath(inputPath);
    if (!parsed) {
      console.error(`Invalid virtual path: ${inputPath}`);
      closeDb();
      process.exit(1);
    }

    doc = db.prepare(`
      SELECT d.collection as collectionName, d.path, d.original_path as originalPath, content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(parsed.collectionName, parsed.path) as typeof doc;

    if (!doc) {
      doc = db.prepare(`
        SELECT d.collection as collectionName, d.path, d.original_path as originalPath, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
        LIMIT 1
      `).get(parsed.collectionName, `%${parsed.path}`) as typeof doc;
    }

    virtualPath = inputPath;
  } else {
    if (!inputPath.startsWith('/') && !inputPath.startsWith('~')) {
      const parts = inputPath.split('/');
      if (parts.length >= 2) {
        const possibleCollection = parts[0];
        const possiblePath = parts.slice(1).join('/');

        const collExists = possibleCollection ? db.prepare(`
          SELECT 1 FROM documents WHERE collection = ? AND active = 1 LIMIT 1
        `).get(possibleCollection) : null;

        if (collExists) {
          doc = db.prepare(`
            SELECT d.collection as collectionName, d.path, d.original_path as originalPath, content.doc as body
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(possibleCollection || "", possiblePath || "") as { collectionName: string; path: string; originalPath: string | null; body: string } | null;

          if (!doc) {
            doc = db.prepare(`
              SELECT d.collection as collectionName, d.path, d.original_path as originalPath, content.doc as body
              FROM documents d
              JOIN content ON content.hash = d.hash
              WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
              LIMIT 1
            `).get(possibleCollection || "", `%${possiblePath}`) as { collectionName: string; path: string; originalPath: string | null; body: string } | null;
          }

          if (!doc) {
            try {
              const handelizedPath = handelize(possiblePath);
              if (handelizedPath !== possiblePath) {
                doc = db.prepare(`
                  SELECT d.collection as collectionName, d.path, d.original_path as originalPath, content.doc as body
                  FROM documents d
                  JOIN content ON content.hash = d.hash
                  WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
                  LIMIT 1
                `).get(possibleCollection || "", `%${handelizedPath}`) as { collectionName: string; path: string; originalPath: string | null; body: string } | null;
              }
            } catch {
              // handelize can throw on invalid paths; ignore and fall through
            }
          }

          if (doc) {
            virtualPath = buildVirtualPath(doc.collectionName, doc.path);
          }
        }
      }
    }

    if (!doc) {
      let fsPath = inputPath;
      if (fsPath.startsWith('~/')) {
        fsPath = homedir() + fsPath.slice(1);
      } else if (!fsPath.startsWith('/')) {
        fsPath = resolve(getPwd(), fsPath);
      }
      fsPath = getRealPath(fsPath);

      const detected = detectCollectionFromPath(db, fsPath);

      if (detected) {
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, d.original_path as originalPath, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(detected.collectionName, detected.relativePath) as { collectionName: string; path: string; originalPath: string | null; body: string } | null;

        if (!doc) {
          try {
            const handelizedPath = handelize(detected.relativePath);
            if (handelizedPath !== detected.relativePath) {
              doc = db.prepare(`
                SELECT d.collection as collectionName, d.path, d.original_path as originalPath, content.doc as body
                FROM documents d
                JOIN content ON content.hash = d.hash
                WHERE d.collection = ? AND d.path = ? AND d.active = 1
              `).get(detected.collectionName, handelizedPath) as { collectionName: string; path: string; originalPath: string | null; body: string } | null;
            }
          } catch {
            // ignore
          }
        }

        if (doc) {
          virtualPath = buildVirtualPath(doc.collectionName, doc.path);
        }
      }
    }

    if (!doc) {
      const allYamlCollections = yamlListCollections();
      const searchFilename = inputPath.split('/').pop() || inputPath;
      for (const coll of allYamlCollections) {
        const candidateFull = resolve(coll.path, inputPath);
        if (existsSync(candidateFull)) {
          const relPath = candidateFull.slice(coll.path.length + 1);
          doc = {
            collectionName: coll.name,
            path: relPath,
            originalPath: relPath,
            body: readFileSync(candidateFull, 'utf-8'),
          };
          virtualPath = buildVirtualPath(coll.name, relPath);
          break;
        }
        const candidateByName = resolve(coll.path, searchFilename);
        if (existsSync(candidateByName)) {
          doc = {
            collectionName: coll.name,
            path: searchFilename,
            originalPath: searchFilename,
            body: readFileSync(candidateByName, 'utf-8'),
          };
          virtualPath = buildVirtualPath(coll.name, searchFilename);
          break;
        }
      }
    }

    if (!doc) {
      virtualPath = inputPath;
    }
  }

  if (!doc) {
    console.error(`Document not found: ${filename}`);
    closeDb();
    process.exit(1);
  }

  const context = getContextForPath(db, doc.collectionName, doc.path);

  const rawContent = doc.originalPath
    ? (resolveRawContent(db, doc.collectionName, doc.originalPath) ?? doc.body)
    : doc.body;
  const fm = parseFrontmatter(rawContent);

  let output = rawContent;

  if (section) {
    const sectionParts = section.split('/').map(s => s.trim()).filter(Boolean);
    const targetHeading = sectionParts[sectionParts.length - 1] ?? section;

    const structure = parseStructure(fm.body);
    const matched = structure.sections.find(s => s.heading === targetHeading);

    if (!matched) {
      console.error(`Section not found: "${section}" in ${doc.path}`);
      closeDb();
      process.exit(1);
    }

    const sectionContent = extractSectionByHeading(fm.body, {
      heading: targetHeading,
      level: matched.level,
    })!;

    if (stripCallouts) {
      const sec = parseStructure(sectionContent);
      output = sec.sections.map(s => {
        const headingLine = s.heading ? `${'#'.repeat(s.level)} ${s.heading}\n\n` : '';
        return headingLine + s.body_no_callouts;
      }).join('\n\n');
    } else {
      output = sectionContent;
    }

    console.log(`# ${matched.heading}`);
    console.log(`Level: H${matched.level}\n`);
  } else if (stripCallouts) {
    const structure = parseStructure(fm.body);
    output = structure.sections.map(s => {
      const headingLine = s.heading ? `${'#'.repeat(s.level)} ${s.heading}\n\n` : '';
      return headingLine + s.body_no_callouts;
    }).join('\n\n');
  }

  if (noCodeblocks) {
    const fences = findCodeFences(output);
    for (let i = fences.length - 1; i >= 0; i--) {
      const { start, end } = fences[i]!;
      output = output.slice(0, start) + output.slice(end);
    }
    output = output.replace(/\n{3,}/g, '\n\n').trim();
  }

  const startLine = fromLine || 1;

  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = output.split('\n');
    const start = startLine - 1;
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    output = lines.slice(start, end).join('\n');
  }

  if (lineNumbers) {
    output = addLineNumbers(output, startLine);
  }

  if (context) {
    console.log(`Folder Context: ${context}\n---\n`);
  }
  console.log(output);
  closeDb();
}

export function multiGet(pattern: string, maxLines?: number, maxBytes: number = DEFAULT_MULTI_GET_MAX_BYTES, format: OutputFormat = "cli"): void {
  const db = getDb();

  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?') && !pattern.includes('{');

  let files: { filepath: string; displayPath: string; bodyLength: number; collection?: string; path?: string }[];

  if (isCommaSeparated) {
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    files = [];
    type DocRow = { virtual_path: string; body_length: number; collection: string; path: string };
    for (const name of names) {
      let doc: DocRow | null = null;

      if (isVirtualPath(name)) {
        const parsed = parseVirtualPath(name);
        if (parsed) {
          doc = db.prepare(`
            SELECT
              'qmd://' || d.collection || '/' || d.path as virtual_path,
              LENGTH(content.doc) as body_length,
              d.collection,
              d.path
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(parsed.collectionName, parsed.path) as DocRow | null;
        }
      } else {
        doc = db.prepare(`
          SELECT
            'qmd://' || d.collection || '/' || d.path as virtual_path,
            LENGTH(content.doc) as body_length,
            d.collection,
            d.path
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path = ? AND d.active = 1
          LIMIT 1
        `).get(name) as DocRow | null;

        if (!doc) {
          doc = db.prepare(`
            SELECT
              'qmd://' || d.collection || '/' || d.path as virtual_path,
              LENGTH(content.doc) as body_length,
              d.collection,
              d.path
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.path LIKE ? AND d.active = 1
            LIMIT 1
          `).get(`%${name}`) as DocRow | null;
        }
      }

      if (doc) {
        files.push({
          filepath: doc.virtual_path,
          displayPath: doc.virtual_path,
          bodyLength: doc.body_length,
          collection: doc.collection,
          path: doc.path
        });
      } else {
        console.error(`File not found: ${name}`);
      }
    }
  } else {
    files = matchFilesByGlob(db, pattern).map(f => ({
      ...f,
      collection: undefined,
      path: undefined
    }));
    if (files.length === 0) {
      console.error(`No files matched pattern: ${pattern}`);
      closeDb();
      process.exit(1);
    }
  }

  const results: { file: string; displayPath: string; title: string; body: string; context: string | null; skipped: boolean; skipReason?: string }[] = [];

  for (const file of files) {
    let collection = file.collection;
    let path = file.path;

    if (!collection || !path) {
      const parsed = parseVirtualPath(file.filepath);
      if (parsed) {
        collection = parsed.collectionName;
        path = parsed.path;
      }
    }

    const context = collection && path ? getContextForPath(db, collection, path) : null;

    if (file.bodyLength > maxBytes) {
      results.push({
        file: file.filepath,
        displayPath: file.displayPath,
        title: file.displayPath.split('/').pop() || file.displayPath,
        body: "",
        context,
        skipped: true,
        skipReason: `File too large (${Math.round(file.bodyLength / 1024)}KB > ${Math.round(maxBytes / 1024)}KB). Use 'qmd get ${file.displayPath}' to retrieve.`,
      });
      continue;
    }

    if (!collection || !path) continue;

    const doc = db.prepare(`
      SELECT content.doc as body, d.title
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(collection, path) as { body: string; title: string } | null;

    if (!doc) continue;

    let body = doc.body;
    if (maxLines !== undefined) {
      const lines = body.split('\n');
      body = lines.slice(0, maxLines).join('\n');
      if (lines.length > maxLines) {
        body += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
      }
    }

    results.push({
      file: file.filepath,
      displayPath: file.displayPath,
      title: doc.title || file.displayPath.split('/').pop() || file.displayPath,
      body,
      context,
      skipped: false,
    });
  }

  closeDb();

  if (format === "json") {
    const output = results.map(r => ({
      file: r.displayPath,
      title: r.title,
      ...(r.context && { context: r.context }),
      ...(r.skipped ? { skipped: true, reason: r.skipReason } : { body: r.body }),
    }));
    console.log(JSON.stringify(output, null, 2));
  } else if (format === "csv") {
    const escapeField = (val: string | null | undefined): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    console.log("file,title,context,skipped,body");
    for (const r of results) {
      console.log([r.displayPath, r.title, r.context, r.skipped ? "true" : "false", r.skipped ? r.skipReason : r.body].map(escapeField).join(","));
    }
  } else if (format === "files") {
    for (const r of results) {
      const ctx = r.context ? `,"${r.context.replace(/"/g, '""')}"` : "";
      const status = r.skipped ? "[SKIPPED]" : "";
      console.log(`${r.displayPath}${ctx}${status ? `,${status}` : ""}`);
    }
  } else if (format === "md") {
    for (const r of results) {
      console.log(`## ${r.displayPath}\n`);
      if (r.title && r.title !== r.displayPath) console.log(`**Title:** ${r.title}\n`);
      if (r.context) console.log(`**Context:** ${r.context}\n`);
      if (r.skipped) {
        console.log(`> ${r.skipReason}\n`);
      } else {
        console.log("```");
        console.log(r.body);
        console.log("```\n");
      }
    }
  } else if (format === "xml") {
    console.log('<?xml version="1.0" encoding="UTF-8"?>');
    console.log("<documents>");
    for (const r of results) {
      console.log("  <document>");
      console.log(`    <file>${escapeXml(r.displayPath)}</file>`);
      console.log(`    <title>${escapeXml(r.title)}</title>`);
      if (r.context) console.log(`    <context>${escapeXml(r.context)}</context>`);
      if (r.skipped) {
        console.log(`    <skipped>true</skipped>`);
        console.log(`    <reason>${escapeXml(r.skipReason || "")}</reason>`);
      } else {
        console.log(`    <body>${escapeXml(r.body)}</body>`);
      }
      console.log("  </document>");
    }
    console.log("</documents>");
  } else {
    for (const r of results) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`File: ${r.displayPath}`);
      console.log(`${'='.repeat(60)}\n`);

      if (r.skipped) {
        console.log(`[SKIPPED: ${r.skipReason}]`);
        continue;
      }

      if (r.context) {
        console.log(`Folder Context: ${r.context}\n---\n`);
      }
      console.log(r.body);
    }
  }
}

export function listFiles(pathArg?: string): void {
  const db = getDb();

  if (!pathArg) {
    const yamlCollections = yamlListCollections();

    if (yamlCollections.length === 0) {
      console.log("No collections found. Run 'qmd collection add .' to index files.");
      closeDb();
      return;
    }

    const collections = yamlCollections.map(coll => {
      const stats = db.prepare(`
        SELECT COUNT(*) as file_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { file_count: number } | null;

      return {
        name: coll.name,
        file_count: stats?.file_count || 0
      };
    });

    console.log(`${c.bold}Collections:${c.reset}\n`);
    for (const coll of collections) {
      console.log(`  ${c.dim}qmd://${c.reset}${c.cyan}${coll.name}/${c.reset}  ${c.dim}(${coll.file_count} files)${c.reset}`);
    }
    closeDb();
    return;
  }

  let collectionName: string;
  let pathPrefix: string | null = null;

  if (pathArg.startsWith('qmd://')) {
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`Invalid virtual path: ${pathArg}`);
      closeDb();
      process.exit(1);
    }
    collectionName = parsed.collectionName;
    pathPrefix = parsed.path;
  } else {
    const parts = pathArg.split('/');
    collectionName = parts[0] || '';
    if (parts.length > 1) {
      pathPrefix = parts.slice(1).join('/');
    }
  }

  const coll = getCollectionFromYaml(collectionName);
  if (!coll) {
    console.error(`Collection not found: ${collectionName}`);
    console.error(`Run 'qmd ls' to see available collections.`);
    closeDb();
    process.exit(1);
  }

  let query: string;
  let params: string[];

  if (pathPrefix) {
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name, `${pathPrefix}%`];
  } else {
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name];
  }

  const files = db.prepare(query).all(...params) as { path: string; title: string; modified_at: string; size: number }[];

  if (files.length === 0) {
    if (pathPrefix) {
      console.log(`No files found under qmd://${collectionName}/${pathPrefix}`);
    } else {
      console.log(`No files found in collection: ${collectionName}`);
    }
    closeDb();
    return;
  }

  const maxSize = Math.max(...files.map(f => formatBytes(f.size).length));

  for (const file of files) {
    const sizeStr = formatBytes(file.size).padStart(maxSize);
    const date = new Date(file.modified_at);
    const timeStr = formatLsTime(date);
    console.log(`${sizeStr}  ${timeStr}  ${c.dim}qmd://${collectionName}/${c.reset}${c.cyan}${file.path}${c.reset}`);
  }

  closeDb();
}

function formatLsTime(date: Date): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, ' ');
  if (date < sixMonthsAgo) {
    return `${month} ${day}  ${date.getFullYear()}`;
  } else {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day} ${hours}:${minutes}`;
  }
}
