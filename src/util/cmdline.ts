/**
 * Command-line parsing for Claude Code detection.
 *
 * Pure, and deliberately conservative: the cost of a false positive is telling
 * everyone you're running an agent when you typed `echo claude`. See SPEC.md
 * §Claude Code detection for the fixtures this must and must not match.
 */

export interface ParsedCommand {
  /** Executable basename, lowercased, extension stripped. */
  readonly bin: string;
  readonly argv: readonly string[];
}

/** Wrappers that delegate to the command that follows them. */
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "exec", "doas"]);

/** Runners whose first non-flag argument is the real program. */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);

/** Two-word runner forms: `pnpm dlx x`, `bun x x`, `yarn dlx x`. */
const RUNNER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["pnpm", "dlx"],
  ["pnpm", "exec"],
  ["yarn", "dlx"],
  ["bun", "x"],
  ["npm", "exec"],
];

export function parseCommand(line: string): ParsedCommand | null {
  const tokens = tokenize(line);
  let i = 0;

  // Bounded: a pathological `sudo sudo sudo …` must not spin.
  for (let guard = 0; guard < 16; guard++) {
    const token = tokens[i];
    if (token === undefined) return null;

    // Leading environment assignments: `ANTHROPIC_API_KEY=x claude`.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i++;
      continue;
    }

    const name = basename(token);

    if (WRAPPERS.has(name)) {
      i++;
      // Skip the wrapper's own flags, but not the program's.
      while (tokens[i]?.startsWith("-")) i++;
      continue;
    }

    const pair = RUNNER_PAIRS.find(([a, b]) => a === name && tokens[i + 1] === b);
    if (pair) {
      i += 2;
      while (tokens[i]?.startsWith("-")) i++;
      continue;
    }

    if (RUNNERS.has(name)) {
      i++;
      while (tokens[i]?.startsWith("-")) i++;
      continue;
    }

    return { bin: stripVersion(name), argv: tokens.slice(i + 1) };
  }

  return null;
}

/**
 * Does this command line start a session matching one of `commands`?
 */
export function matchesCommand(line: string, commands: readonly string[]): boolean {
  const parsed = parseCommand(line);
  if (!parsed) return false;
  const wanted = commands.map((c) => basename(c).toLowerCase());
  return wanted.includes(parsed.bin);
}

/**
 * Fallback for when shell integration is unavailable: terminals get renamed
 * after their foreground process, so the title alone is a weak signal. Matched
 * whole-word only, so a terminal named "claude-notes" does not count.
 */
export function nameMatchesCommand(name: string, commands: readonly string[]): boolean {
  const normalised = name.trim().toLowerCase();
  return commands.some((command) => {
    const target = basename(command).toLowerCase();
    return normalised === target || normalised.startsWith(`${target} `);
  });
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;

  const chars = [...line.trim()];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;

    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    // Only treat a backslash as an escape when it precedes something escapable.
    // Otherwise it is a Windows path separator, and eating it turns
    // `C:\tools\claude.exe` into `c:toolsclaude`.
    if (char === "\\" && quote !== "'" && isEscapable(chars[i + 1])) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    // A pipeline or chain starts a new command; only the first one is ours.
    if (char === "|" || char === ";" || char === "&") break;
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

function isEscapable(char: string | undefined): boolean {
  return char !== undefined && (/\s/.test(char) || `"'\\|;&$`.includes(char));
}

function basename(token: string): string {
  const parts = token.replace(/\\/g, "/").split("/");
  const last = parts[parts.length - 1] ?? token;
  return last.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/** `claude@latest` and `claude@1.2.3` are both `claude`. */
function stripVersion(name: string): string {
  const at = name.lastIndexOf("@");
  return at > 0 ? name.slice(0, at) : name;
}
