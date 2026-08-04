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

const SIDECAR_VERSION = 1;
const SESSIONS_DIR = join(homedir(), ".claude", "cursor2discord", "sessions");

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
  Glob: "searching",
};

main();

function main() {
  try {
    const mode = process.argv[2];
    const payload = readStdin();
    if (!payload) return finish(mode, null);

    const sessionId = payload.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return finish(mode, null);

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
  };

  if (event === "SessionStart") {
    return { ...base, startedAt: Date.now(), model: str(payload.model), activity: null };
  }

  // Anything that ends a turn or a tool call means Claude is thinking again.
  if (event === "PostToolUse" || event === "Stop" || event === "PostToolUseFailure") {
    return { ...base, activity: null };
  }

  if (event === "PreToolUse") {
    const tool = str(payload.tool_name);
    if (!tool) return base;
    return {
      ...base,
      activity: { tool, verb: VERBS[tool] ?? "working", target: targetOf(payload.tool_input), since: Date.now() },
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
function targetOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const path = str(toolInput.file_path) ?? str(toolInput.notebook_path);
  if (path) return path.split(/[\\/]/).pop() ?? null;
  // For Bash, the binary alone: `npm` from `npm run build -- --watch`.
  const command = str(toolInput.command);
  if (command) return command.trim().split(/\s+/)[0]?.split(/[\\/]/).pop() ?? null;
  return null;
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
