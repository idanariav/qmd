// CLI URI utilities — editor links and terminal hyperlinks

import { loadConfig } from "../collections.js";

const DEFAULT_EDITOR_URI_TEMPLATE = "vscode://file/{path}:{line}:{col}";

function encodePathForEditorUri(absolutePath: string): string {
  return encodeURI(absolutePath)
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");
}

export function getEditorUriTemplate(): string {
  const envTemplate = process.env.QMD_EDITOR_URI?.trim();
  if (envTemplate) return envTemplate;

  try {
    const config = loadConfig() as unknown as {
      editor_uri?: string;
      editor_uri_template?: string;
      editorUri?: string;
      [key: string]: unknown;
    };
    const configTemplate = (
      config.editor_uri
      || config.editor_uri_template
      || config.editorUri
      || (typeof config["editor-uri"] === "string" ? config["editor-uri"] : undefined)
    )?.trim();

    if (configTemplate) return configTemplate;
  } catch {
    // Ignore config parsing issues and use default template.
  }

  return DEFAULT_EDITOR_URI_TEMPLATE;
}

export function buildEditorUri(template: string, absolutePath: string, line: number, col: number): string {
  const safeLine = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
  const safeCol = Number.isFinite(col) && col > 0 ? Math.floor(col) : 1;
  const encodedPath = encodePathForEditorUri(absolutePath);

  return template
    .replace(/\{path\}/g, encodedPath)
    .replace(/\{line\}/g, String(safeLine))
    .replace(/\{col\}/g, String(safeCol))
    .replace(/\{column\}/g, String(safeCol));
}

export function termLink(text: string, url: string, isTTY: boolean = !!process.stdout.isTTY): string {
  if (!isTTY) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}
