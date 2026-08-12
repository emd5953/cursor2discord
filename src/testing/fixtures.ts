import type { Config } from "../config.js";
import type { ClaudeLiveState, Snapshot } from "../state.js";

/**
 * Shared test fixtures. Excluded from the packaged extension by `.vscodeignore`
 * — this file exists so `format` and `build` assert against the same defaults,
 * since a golden payload is only meaningful if its inputs are the shipped ones.
 */

/** Mirrors the defaults in package.json, which is what users actually run. */
export const config: Config = {
  enabled: true,
  applicationId: "1",
  showElapsedTime: true,
  elapsedTimeResetsOnFileChange: false,
  idleTimeoutSeconds: 300,
  idleBehavior: "showIdle",
  detectClaudeCode: true,
  claudeCodeCommands: ["claude"],
  claudeCode: { liveActivity: true, showTokens: true },
  detectCursorAi: true,
  priority: ["claudeCode", "cursorAi", "editing", "idle"],
  privacy: {
    mode: "full",
    ignoredWorkspaces: [],
    ignoredFiles: ["**/.env", "**/*.pem"],
  },
  templates: {
    editing: { details: "Editing {file}", state: "{workspace} — {branch}" },
    idle: { details: "Idle", state: "in {workspace}" },
    claudeCode: {
      details: "Claude Code — {claudeActivity}",
      state: "{sessionTitle} · {tokenSummary} · up {cursorUptime}",
    },
    cursorAi: { details: "Vibing with Cursor AI", state: "{workspace} — {branch}" },
  },
  buttons: [],
  statusBar: { enabled: true },
};

export const now = Date.now();

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    editor: null,
    workspace: { name: "my-project", folderPath: "/w" },
    git: { branch: "main", repoName: "my-project", remoteUrl: null },
    claudeCode: { sessions: 0, since: null },
    claudeLive: null,
    cursorAi: { active: false, since: null, confidence: 0 },
    focused: true,
    unfocusedSince: null,
    lastInputAt: now,
    sessionStartedAt: now,
    fileOpenedAt: now,
    ...overrides,
  };
}

export function live(overrides: Partial<ClaudeLiveState> = {}): ClaudeLiveState {
  return {
    sessionId: "s1",
    startedAt: now,
    sessionTitle: "add rate limiting",
    model: "Opus",
    activity: { tool: "Edit", verb: "editing", target: "client.ts" },
    tokens: { input: 15500, output: 1200, usedPercentage: 8 },
    ...overrides,
  };
}

export function editor(overrides: Partial<NonNullable<Snapshot["editor"]>> = {}) {
  return {
    fileName: "build.ts",
    relPath: "src/presence/build.ts",
    languageId: "typescript",
    line: 12,
    column: 3,
    lineCount: 128,
    problems: 0,
    isUntitled: false,
    ...overrides,
  };
}
