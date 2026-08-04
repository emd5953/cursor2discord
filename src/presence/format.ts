import type { Config } from "../config.js";
import type { Snapshot } from "../state.js";

/**
 * Template expansion.
 *
 * The one non-obvious rule: an unresolvable variable collapses the separator
 * around it, so `"{workspace} — {branch}"` with no git repo yields
 * `"my-project"` rather than `"my-project — "`. See SPEC.md §Payload construction.
 */

const VARIABLE = /\{(\w+)\}/g;

export function resolveVariables(
  snapshot: Snapshot,
  config: Config,
): Readonly<Record<string, string | null>> {
  const { editor, workspace, git } = snapshot;
  const mode = config.privacy.mode;

  const hideFiles = mode === "hideFileNames" || mode === "minimal";
  const hideWorkspace = mode === "hideWorkspace" || mode === "minimal";

  return {
    file: hideFiles ? null : (editor?.fileName ?? null),
    ext: hideFiles ? null : (extensionOf(editor?.fileName) ?? null),
    relPath: hideFiles || hideWorkspace ? null : (editor?.relPath ?? null),
    language: editor?.languageId ?? null,
    workspace: hideWorkspace ? null : (workspace?.name ?? null),
    repo: hideWorkspace ? null : (git?.repoName ?? null),
    branch: hideWorkspace ? null : (git?.branch ?? null),
    repoUrl: hideWorkspace ? null : (git?.remoteUrl ?? null),
    line: editor ? String(editor.line) : null,
    column: editor ? String(editor.column) : null,
    lineCount: editor ? String(editor.lineCount) : null,
    problems: editor ? String(editor.problems) : null,
  };
}

interface Token {
  readonly text: string;
  readonly isVariable: boolean;
  readonly resolved: boolean;
}

function tokenize(template: string, values: Readonly<Record<string, string | null>>): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  for (const match of template.matchAll(new RegExp(VARIABLE))) {
    const index = match.index;
    if (index > cursor) {
      tokens.push({ text: template.slice(cursor, index), isVariable: false, resolved: true });
    }
    const value = values[match[1]!] ?? null;
    tokens.push({ text: value ?? "", isVariable: true, resolved: value !== null });
    cursor = index + match[0].length;
  }

  if (cursor < template.length) {
    tokens.push({ text: template.slice(cursor), isVariable: false, resolved: true });
  }

  return tokens;
}

export function format(template: string, snapshot: Snapshot, config: Config): string {
  const tokens = tokenize(template, resolveVariables(snapshot, config));
  const kept = tokens.map((token) => (token.resolved ? token.text : ""));

  // A variable that resolved to nothing leaves its joining punctuation dangling.
  // Drop the separator on one side of the hole — preferring the one before it,
  // so "{workspace} — {branch}" degrades to "my-project", not "my-project —".
  tokens.forEach((token, i) => {
    if (token.resolved) return;
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    if (before && !before.isVariable && isSeparator(before.text)) kept[i - 1] = "";
    else if (after && !after.isVariable && isSeparator(after.text)) kept[i + 1] = "";
  });

  return collapse(kept.join(""));
}

/** A literal run that only exists to join two values. */
function isSeparator(text: string): boolean {
  return /^[\s\-—–|·:,/([\])]*$/.test(text);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extensionOf(fileName: string | undefined): string | null {
  if (!fileName) return null;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1) : null;
}

const MAX_BYTES = 128;
const encoder = new TextEncoder();

/**
 * Discord truncates `details`/`state` at 128 **bytes** and rejects 1-char
 * strings. Clamp on a grapheme boundary, pad singles, and treat empty as
 * "omit the field" rather than sending "".
 */
export function clampField(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  let out = trimmed;
  if (encoder.encode(out).length > MAX_BYTES) {
    const graphemes = [...out];
    out = "";
    for (const grapheme of graphemes) {
      if (encoder.encode(out + grapheme + "…").length > MAX_BYTES) break;
      out += grapheme;
    }
    out += "…";
  }

  return out.length === 1 ? `${out} ` : out;
}
