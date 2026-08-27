#!/usr/bin/env node
/**
 * cursor2discord bridge.
 *
 * Claude Code splits the data we need across two channels that never meet:
 * hooks know which tool is running but carry no token or cost data, and the
 * statusLine command carries tokens but knows nothing about the current tool.
 * This script is registered as both, and merges whatever it is handed into one
 * sidecar file per session. The Cursor extension watches the directory.
 *
 *   node bridge.mjs hook        # stdin: hook payload    → merge, print nothing
 *   node bridge.mjs statusline  # stdin: statusLine JSON → merge, print a status line
 *
 * Hard rule: this runs inside somebody's agent loop, and PreToolUse blocks the
 * tool call until it returns. It must never throw, never hang, and never exit
 * non-zero. A Discord status bar is not worth breaking a session over.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SIDECAR_VERSION = 1;
const HOME_DIR = join(homedir(), ".claude", "cursor2discord");
const SESSIONS_DIR = join(HOME_DIR, "sessions");
/**
 * Where `/cursor2discord:enable-tokens` puts its copy of this file. The status
 * line needs a stable path — `${CLAUDE_PLUGIN_ROOT}` is undefined in that
 * context, and the plugin's own cache directory is versioned — so the copy has
 * to exist. `refreshTokenTierCopy` is what keeps it from becoming a fork.
 */
const TOKEN_TIER_COPY = join(HOME_DIR, "bridge.mjs");

/** Tool name → present-tense verb shown on the Discord card. */
const VERBS = {
  Edit: "editing",
  Write: "writing",
  NotebookEdit: "editing",
  Read: "reading",
  Bash: "running a command",
  Task: "delegating to a subagent",
  WebFetch: "reading the web",
  WebSearch: "searching the web",
  Grep: "searching",
  Glob: "looking for files",
  TodoWrite: "updating the plan",
};

// Only when run as the hook itself. Importing it — which the tests do — must
// not read stdin or exit the process.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) main();

export { fromHook, fromStatusLine, targetOf, statusLineText, shouldRefreshCopy };

function main() {
  try {
    const mode = process.argv[2];
    const payload = readStdin();
    if (!payload) return finish(mode, null);

    const sessionId = payload.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return finish(mode, null);

    // A new session is the one moment we know we are running from the plugin
    // and nothing is waiting on us.
    if (payload.hook_event_name === "SessionStart") refreshTokenTierCopy();

    if (payload.hook_event_name === "SessionEnd") {
      remove(sessionId);
      return finish(mode, null);
    }

    const merged = merge(sessionId, mode === "statusline" ? fromStatusLine(payload) : fromHook(payload));
    finish(mode, merged);
  } catch {
    // Deliberately silent. See the header.
    finish(process.argv[2], null);
  }
}

/** statusline mode owes Claude Code a status line; hook mode owes it nothing. */
function finish(mode, sidecar) {
  if (mode === "statusline") process.stdout.write(statusLineText(sidecar) + "\n");
  process.exit(0);
}

function readStdin() {
  try {
    // fd 0 is a pipe here; readFileSync drains it without an async round trip.
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// --- payload → sidecar fragment -------------------------------------------

function fromHook(payload) {
  const event = payload.hook_event_name;

  const base = {
    cwd: str(payload.cwd),
    updatedAt: Date.now(),
    // The hook runs as a child of `claude`, so the parent pid identifies the
    // session process. The extension checks it for liveness: hooks only fire
    // on tool calls and turn ends, so a session waiting at the prompt emits
    // nothing, and a timestamp alone would make it look dead.
    pid: typeof process.ppid === "number" ? process.ppid : null,
  };

  if (event === "SessionStart") {
    return { ...base, startedAt: Date.now(), model: str(payload.model), activity: null };
  }

  // A finished tool is not a finished turn. Another tool is usually seconds
  // away, and blanking the activity here is what left the card reading a bare
  // "Claude Code" for most of its life. Omitting the field holds the last tool;
  // `merge` treats undefined as "nothing to say".
  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    return base;
  }

  // A turn ending is different: nothing is running and none will start until
  // the user replies. Say so, rather than holding a tool that finished minutes
  // ago.
  if (event === "Stop") {
    return { ...base, activity: { tool: null, verb: "thinking", target: null, since: Date.now() } };
  }

  if (event === "PreToolUse") {
    const tool = str(payload.tool_name);
    if (!tool) return base;
    return {
      ...base,
      activity: {
        tool,
        verb: VERBS[tool] ?? "working",
        target: targetOf(payload.tool_input, tool),
        since: Date.now(),
      },
    };
  }

  return base;
}

function fromStatusLine(payload) {
  const context = payload.context_window ?? {};
  const cost = payload.cost ?? {};

  const input = num(context.total_input_tokens);
  const output = num(context.total_output_tokens);

  return {
    cwd: str(payload.workspace?.current_dir) ?? str(payload.cwd),
    updatedAt: Date.now(),
    pid: typeof process.ppid === "number" ? process.ppid : null,
    sessionTitle: str(payload.session_name),
    model: str(payload.model?.display_name),
    durationMs: num(cost.total_duration_ms),
    tokens:
      input === null && output === null
        ? null
        : {
            input: input ?? 0,
            output: output ?? 0,
            usedPercentage: num(context.used_percentage) ?? 0,
          },
  };
}

/**
 * The one field worth showing from tool_input. Never the whole object — that
 * contains prompts, command lines and file contents, none of which belong
 * anywhere near a chat server.
 */
function targetOf(toolInput, tool) {
  if (!toolInput || typeof toolInput !== "object") return null;

  const path = str(toolInput.file_path) ?? str(toolInput.notebook_path);
  if (path) return basename(path);

  if (tool === "Bash") return bashTarget(str(toolInput.command));

  // Grep and Glob: where it looked, never what it looked for. A search pattern
  // is the user's own text and can trivially contain a secret being hunted.
  if (tool === "Grep" || tool === "Glob") {
    const scope = str(toolInput.path);
    return scope ? basename(scope) : null;
  }

  // The subagent's type is one of a fixed set of names; its prompt is not.
  if (tool === "Task") return str(toolInput.subagent_type);

  // Host only — a URL path or query string carries tokens often enough.
  if (tool === "WebFetch") {
    const url = str(toolInput.url);
    if (!url) return null;
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  // WebSearch queries and TodoWrite items are user content; the verb says
  // enough on its own.
  return null;
}

function basename(value) {
  return value.split(/[\\/]/).pop() || null;
}

/**
 * `npm run`, `git commit` — the binary plus a subcommand, and only when that
 * second token is a bare word. Anything carrying a flag, a path, an assignment
 * or a quote is dropped, because that is where secrets live in a command line.
 */
function bashTarget(command) {
  if (!command) return null;

  const tokens = command.trim().split(/\s+/);
  // `FOO=bar cmd` — the assignment is not the binary, and its value is very
  // often the secret. Drop leading assignments the way util/cmdline.ts does.
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();

  const binary = tokens[0] ? basename(tokens[0]) : null;
  // A binary name is a bare word. Anything else is a shape we don't understand,
  // and printing what we don't understand is how content escapes.
  if (!binary || !/^[a-z0-9._-]+$/i.test(binary)) return null;

  const second = tokens[1];
  return second && /^[a-z][a-z0-9-]*$/i.test(second) ? `${binary} ${second}` : binary;
}

// --- token tier copy -------------------------------------------------------

/**
 * Keep the status line's copy of this file in step with the plugin.
 *
 * The copy is a snapshot taken at `/cursor2discord:enable-tokens` time, and
 * before this it was never refreshed — a plugin update moved the hooks forward
 * and left the token tier running whatever shipped the day the user enabled it.
 * That divergence is silent by construction: the copy still exits 0 and still
 * prints a status line, so nothing looks broken until the sidecar schema moves
 * and the extension quietly stops seeing tokens.
 *
 * Only ever *refreshes* — if the copy is absent the user has not enabled the
 * token tier, and installing a file they did not ask for is not this hook's
 * business.
 */
function refreshTokenTierCopy() {
  try {
    const self = fileURLToPath(import.meta.url);
    const current = readFileSync(TOKEN_TIER_COPY, "utf8");
    const latest = readFileSync(self, "utf8");
    if (!shouldRefreshCopy(self, TOKEN_TIER_COPY, current, latest)) return;

    // Temp + rename: the status line may fire from this exact path mid-write.
    const temp = `${TOKEN_TIER_COPY}.${process.pid}.tmp`;
    writeFileSync(temp, latest, "utf8");
    renameSync(temp, TOKEN_TIER_COPY);
  } catch {
    // The copy does not exist, or is not ours to write. Silent by design.
  }
}

/** Pure half, so the "don't copy a file onto itself" case is testable. */
function shouldRefreshCopy(selfPath, copyPath, currentText, latestText) {
  if (selfPath === copyPath) return false;
  return currentText !== latestText;
}

// --- sidecar io ------------------------------------------------------------

function pathFor(sessionId) {
  // Session ids come from Claude Code, but this builds a filesystem path, so
  // anything that could escape the directory is not worth trusting.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "");
  return safe ? join(SESSIONS_DIR, `${safe}.json`) : null;
}

function read(sessionId) {
  try {
    const file = pathFor(sessionId);
    if (!file) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed?.version === SIDECAR_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Merge rather than replace: the two channels populate disjoint fields at
 * different times, and a statusLine write must not erase the current tool.
 * `undefined` means "this channel has nothing to say"; `null` is a real value.
 */
function merge(sessionId, fragment) {
  const file = pathFor(sessionId);
  if (!file) return null;

  const previous = read(sessionId) ?? {
    version: SIDECAR_VERSION,
    sessionId,
    pid: null,
    cwd: null,
    sessionTitle: null,
    model: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    activity: null,
    tokens: null,
    durationMs: null,
  };

  const next = { ...previous };
  for (const [key, value] of Object.entries(fragment)) {
    if (value !== undefined) next[key] = value;
  }
  next.version = SIDECAR_VERSION;
  next.sessionId = sessionId;

  write(file, next);
  return next;
}

function write(file, sidecar) {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    // Temp + rename, so the extension never reads a half-written file.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(sidecar), "utf8");
    renameSync(temp, file);
  } catch {
    // Silent by design.
  }
}

function remove(sessionId) {
  try {
    const file = pathFor(sessionId);
    if (file) rmSync(file, { force: true });
  } catch {
    // Silent by design.
  }
}

// --- status line -----------------------------------------------------------

/**
 * Users who enable the token tier give up their status line to this script, so
 * it has to hand back something worth having.
 */
function statusLineText(sidecar) {
  if (!sidecar) return "";

  const parts = [];
  if (sidecar.model) parts.push(sidecar.model);
  if (sidecar.activity) {
    parts.push(`${sidecar.activity.verb}${sidecar.activity.target ? ` ${sidecar.activity.target}` : ""}`);
  }
  if (sidecar.tokens) {
    parts.push(`${compact(sidecar.tokens.input + sidecar.tokens.output)} tok · ${sidecar.tokens.usedPercentage}% ctx`);
  }
  return parts.join("  ·  ");
}

function compact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

// --- coercion --------------------------------------------------------------

function str(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
