// Commands: showSkill, installSkill, showHelp, showVersion

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { readFileSync, lstatSync, unlinkSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readlinkSync, realpathSync } from "fs";
import { relative as relativePath } from "path";
import { createInterface } from "readline/promises";
import { resolve, homedir, getPwd } from "../../store.js";
import { getEmbeddedQmdSkillContent, getEmbeddedQmdSkillFiles } from "../../embedded-skills.js";
import { getDbPath } from "../store-access.js";

function getSkillInstallDir(globalInstall: boolean): string {
  return globalInstall
    ? resolve(homedir(), ".agents", "skills", "qmd")
    : resolve(getPwd(), ".agents", "skills", "qmd");
}

function getClaudeSkillLinkPath(globalInstall: boolean): string {
  return globalInstall
    ? resolve(homedir(), ".claude", "skills", "qmd")
    : resolve(getPwd(), ".claude", "skills", "qmd");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function removePath(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
  } else {
    unlinkSync(path);
  }
}

export function showSkill(): void {
  console.log("QMD Skill (embedded)");
  console.log("");
  const content = getEmbeddedQmdSkillContent();
  process.stdout.write(content.endsWith("\n") ? content : content + "\n");
}

function writeEmbeddedSkill(targetDir: string, force: boolean): void {
  if (pathExists(targetDir)) {
    if (!force) {
      throw new Error(`Skill already exists: ${targetDir} (use --force to replace it)`);
    }
    removePath(targetDir);
  }

  mkdirSync(targetDir, { recursive: true });
  for (const file of getEmbeddedQmdSkillFiles()) {
    const destination = resolve(targetDir, file.relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content, "utf-8");
  }
}

function ensureClaudeSymlink(linkPath: string, targetDir: string, force: boolean): boolean {
  const parentDir = dirname(linkPath);
  if (pathExists(parentDir)) {
    const resolvedTargetDir = realpathSync(dirname(targetDir));
    const resolvedLinkParent = realpathSync(parentDir);
    if (resolvedTargetDir === resolvedLinkParent) {
      return false;
    }
  }

  const linkTarget = relativePath(parentDir, targetDir) || ".";
  mkdirSync(parentDir, { recursive: true });

  if (pathExists(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() && readlinkSync(linkPath) === linkTarget) {
      return true;
    }
    if (!force) {
      throw new Error(`Claude skill path already exists: ${linkPath} (use --force to replace it)`);
    }
    removePath(linkPath);
  }

  symlinkSync(linkTarget, linkPath, "dir");
  return true;
}

async function shouldCreateClaudeSymlink(linkPath: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`Tip: create a Claude symlink manually at ${linkPath}`);
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Create a symlink in ${linkPath}? [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

export async function installSkill(globalInstall: boolean, force: boolean, autoYes: boolean): Promise<void> {
  const installDir = getSkillInstallDir(globalInstall);
  writeEmbeddedSkill(installDir, force);
  console.log(`✓ Installed QMD skill to ${installDir}`);

  const claudeLinkPath = getClaudeSkillLinkPath(globalInstall);
  if (!(await shouldCreateClaudeSymlink(claudeLinkPath, autoYes))) return;

  const linked = ensureClaudeSymlink(claudeLinkPath, installDir, force);
  if (linked) {
    console.log(`✓ Linked Claude skill at ${claudeLinkPath}`);
  } else {
    console.log(`✓ Claude already sees the skill via ${dirname(claudeLinkPath)}`);
  }
}

export function showHelp(): void {
  console.log("qmd — Quick Markdown Search");
  console.log("");
  console.log("Usage:");
  console.log("  qmd <command> [options]");
  console.log("");
  console.log("Primary commands:");
  console.log("  qmd hsearch <query>           - Hybrid search with auto expansion + reranking (recommended)");
  console.log("  qmd hsearch 'lex:..\\nvec:...' - Structured query document (you provide lex/vec/hyde lines)");
  console.log("  qmd tsearch <query>           - Full-text BM25 keywords (no LLM)");
  console.log("  qmd vsearch <query>           - Vector similarity only");
  console.log("  qmd fsearch <filter>          - Filter by frontmatter/tags/dates/sections (DSL, no LLM)");
  console.log("  qmd get <file> [--section H]  - Show document, extract section, or strip callouts/codeblocks");
  console.log("  qmd multi-get <pattern>       - Batch fetch via glob or comma-separated list");
  console.log("  qmd mcp                       - Start the MCP server (stdio transport for AI agents)");
  console.log("  qmd bench <fixture.json>      - Run search quality benchmarks against a fixture file");
  console.log("");
  console.log("Collections & context:");
  console.log("  qmd collection add/list/remove/rename/show   - Manage indexed folders (show: view collection config)");
  console.log("  qmd context add/list/rm                      - Attach human-written summaries");
  console.log("  qmd ls [collection[/path]]                   - Inspect indexed files");
  console.log("");
  console.log("Maintenance:");
  console.log("  qmd status                    - View index + collection health");
  console.log("  qmd index [--pull]            - Re-index collections (optionally git pull first)");
  console.log("  qmd embed [-f]                - Generate/refresh vector embeddings");
  console.log("    --max-docs-per-batch <n>    - Cap docs loaded into memory per embedding batch");
  console.log("    --max-batch-mb <n>          - Cap UTF-8 MB loaded into memory per embedding batch");
  console.log("  qmd cleanup                   - Clear caches, vacuum DB");
  console.log("");
  console.log("Query syntax (qmd hsearch):");
  console.log("  QMD queries are either a single expand query (no prefix) or a multi-line");
  console.log("  document where every line is typed with lex:, vec:, or hyde:. This grammar");
  console.log("  is enforced in the CLI.");
  console.log("");
  const grammar = [
    `query          = expand_query | query_document ;`,
    `expand_query   = text | explicit_expand ;`,
    `explicit_expand= "expand:" text ;`,
    `query_document = [ intent_line ] { typed_line } ;`,
    `intent_line    = "intent:" text newline ;`,
    `typed_line     = type ":" text newline ;`,
    `type           = "lex" | "vec" | "hyde" ;`,
    `text           = quoted_phrase | plain_text ;`,
    `quoted_phrase  = '"' { character } '"' ;`,
    `plain_text     = { character } ;`,
    `newline        = "\\n" ;`,
  ];
  console.log("  Grammar:");
  for (const line of grammar) {
    console.log(`    ${line}`);
  }
  console.log("");
  console.log("  Examples:");
  console.log("    qmd hsearch \"how does auth work\"              # single-line → implicit expand");
  console.log("    qmd hsearch $'lex: CAP theorem\\nvec: consistency'  # typed query document");
  console.log("    qmd hsearch $'lex: \"exact matches\" sports -baseball'  # phrase + negation lex search");
  console.log("    qmd hsearch $'hyde: Hypothetical answer text'     # hyde-only document");
  console.log("");
  console.log("  Constraints:");
  console.log("    - Standalone expand queries cannot mix with typed lines.");
  console.log("    - Query documents allow only lex:, vec:, or hyde: prefixes.");
  console.log("    - Each typed line must be single-line text with balanced quotes.");
  console.log("");
  console.log("AI agents & integrations:");
  console.log("  - Run `qmd mcp` to expose the MCP server (stdio) to agents/IDEs.");
  console.log("  - `qmd mcp --http [--port N]` starts an HTTP server (default port 8181).");
  console.log("  - `qmd mcp --http --daemon` runs the HTTP server in background.");
  console.log("  - `qmd mcp stop` stops the background daemon.");
  console.log("");
  console.log("Global options:");
  console.log("  --index <name>             - Use a named index (default: index)");
  console.log("  QMD_EDITOR_URI             - Editor link template for clickable TTY search output");
  console.log("");
  console.log("Search options:");
  console.log("  -n <num>                   - Max results (default 5, or 20 for --files/--json)");
  console.log("  --all                      - Return all matches (pair with --min-score)");
  console.log("  --min-score <num>          - Minimum similarity score");
  console.log("  --full                     - Output full document instead of snippet");
  console.log("  -C, --candidate-limit <n>  - Max candidates to rerank (default 40, lower = faster)");
  console.log("  --no-rerank                - Skip LLM reranking (use RRF scores only, much faster on CPU)");
  console.log("  --line-numbers             - Include line numbers in output");
  console.log("  --explain                  - Include retrieval score traces (query --json/CLI)");
  console.log("  --files | --json | --csv | --md | --xml  - Output format");
  console.log("  -q, --quiet                - Suppress progress/tip messages (auto-enabled for --json/--csv/--xml/--files)");
  console.log("  -c, --collection <name>    - Filter by one or more collections");
  console.log("");
  console.log("Get options:");
  console.log("  --section <heading>        - Extract a specific section by heading name (supports Parent/Child)");
  console.log("  --from <line>              - Start at line number");
  console.log("  -l <num>                   - Max lines to return");
  console.log("  --no-callouts              - Strip Obsidian callout blocks (> [!NOTE], > [!WARNING], etc.)");
  console.log("  --no-codeblocks            - Strip fenced code blocks (``` ... ```) from output");
  console.log("");
  console.log("Embed/query options:");
  console.log("  --chunk-strategy <auto|regex> - Chunking mode (default: regex; auto uses AST for code files)");
  console.log("");
  console.log("Multi-get options:");
  console.log("  -l <num>                   - Maximum lines per file");
  console.log("  --max-bytes <num>          - Skip files larger than N bytes (default 10240)");
  console.log("  --json/--csv/--md/--xml/--files - Same formats as search");
  console.log("");
  console.log(`Index: ${getDbPath()}`);
}

export async function showVersion(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(scriptDir, "..", "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  let commit = "";
  try {
    commit = execSync(`git -C ${scriptDir} rev-parse --short HEAD`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // Not a git repo or git not available
  }

  const versionStr = commit ? `${pkg.version} (${commit})` : pkg.version;
  console.log(`qmd ${versionStr}`);
}
