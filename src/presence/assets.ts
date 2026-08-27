/**
 * Icon resolution. Discord accepts a raw https URL for `large_image`/`small_image`
 * and proxies it, so nothing is ever uploaded to the application — that is what
 * lets a custom `applicationId` work with zero setup. See SPEC.md §Assets.
 *
 * The ref is a release tag rather than `main` so a bad icon commit can't change
 * what every installed copy renders — a floating ref means every user's card
 * follows the tip of the branch, which is the one thing pinning exists to stop.
 * It was `main` up to 0.1.1, which made the comment above a description of the
 * intent rather than of the code. Bump this in the same commit as the version.
 */
const ASSET_REF = "v0.1.3";
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
  // Anything whose capitalisation isn't just "first letter up" needs to be here
  // — `capitalise("typescript")` yields "Typescript", which looks like a typo.
  typescript: "TypeScript",
  javascript: "JavaScript",
  typescriptreact: "TypeScript React",
  javascriptreact: "JavaScript React",
  php: "PHP",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  sql: "SQL",
  xml: "XML",
  latex: "LaTeX",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  objectivec: "Objective-C",
  fsharp: "F#",
  restructuredtext: "reStructuredText",
  vue: "Vue",
  git: "Git",
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

/**
 * The large image is the app, not the file: a card whose headline picture is a
 * 512px "MD" reads as a markdown document, not as Cursor. The language icon it
 * displaced moves to the badge slot — see build.ts.
 */
export function appAsset(): Asset {
  return { key: url("cursor"), text: "Cursor" };
}

/**
 * The badge says who is driving. Outside an AI session there is nobody to name,
 * so the slot goes back to the language icon rather than repeating the large
 * image's own Cursor mark.
 */
export function badgeForKind(kind: "claudeCode" | "cursorAi" | "editing" | "idle"): Asset | null {
  switch (kind) {
    case "claudeCode":
      return { key: url("claude"), text: "Claude Code" };
    case "cursorAi":
      return { key: url("cursor-ai"), text: "Cursor AI" };
    case "editing":
    case "idle":
      return null;
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
