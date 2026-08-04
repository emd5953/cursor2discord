/**
 * Icon resolution. Discord accepts a raw https URL for `large_image`/`small_image`
 * and proxies it, so nothing is ever uploaded to the application — that is what
 * lets a custom `applicationId` work with zero setup. See SPEC.md §Assets.
 *
 * The ref is pinned rather than floating on `main` so a bad icon commit can't
 * change what every installed copy renders.
 */
const ASSET_REF = "main";
const ASSET_BASE = `https://cdn.jsdelivr.net/gh/emd5953/cursor2discord@${ASSET_REF}/assets`;

export interface Asset {
  readonly key: string;
  readonly text: string;
}

/** languageId → icon basename. Unlisted languages fall back to a generic file. */
const ICONS: Readonly<Record<string, string>> = {
  typescript: "typescript",
  typescriptreact: "typescript",
  javascript: "javascript",
  javascriptreact: "javascript",
  python: "python",
  rust: "rust",
  go: "go",
  java: "java",
  kotlin: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  csharp: "csharp",
  ruby: "ruby",
  php: "php",
  html: "html",
  css: "css",
  scss: "css",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  toml: "toml",
  markdown: "markdown",
  shellscript: "shell",
  sql: "sql",
  dockerfile: "docker",
  lua: "lua",
  dart: "dart",
  elixir: "elixir",
  haskell: "haskell",
  scala: "scala",
  vue: "vue",
  svelte: "svelte",
  plaintext: "file",
};

/** Human-readable label shown on icon hover. */
const NAMES: Readonly<Record<string, string>> = {
  typescriptreact: "TypeScript React",
  javascriptreact: "JavaScript React",
  cpp: "C++",
  csharp: "C#",
  shellscript: "Shell",
  jsonc: "JSON with comments",
};

function url(name: string): string {
  return `${ASSET_BASE}/${name}.png`;
}

export function assetForLanguage(languageId: string | null): Asset {
  if (!languageId) return { key: url("file"), text: "Idle" };
  const icon = ICONS[languageId] ?? "file";
  const text = NAMES[languageId] ?? capitalise(languageId);
  return { key: url(icon), text };
}

export function badgeForKind(kind: "claudeCode" | "cursorAi" | "editing" | "idle"): Asset | null {
  switch (kind) {
    case "claudeCode":
      return { key: url("claude"), text: "Claude Code" };
    case "cursorAi":
      return { key: url("cursor-ai"), text: "Cursor AI" };
    case "editing":
      return { key: url("cursor"), text: "Cursor" };
    case "idle":
      return null;
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
