import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Config } from "../config.js";
import type { ClaudeLiveState, Snapshot } from "../state.js";
import { clampField, format } from "./format.js";

const config: Config = {
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
    claudeCode: { details: "Claude Code — {claudeActivity}", state: "{sessionTitle}" },
    cursorAi: { details: "Vibing with Cursor AI", state: "{workspace} — {branch}" },
  },
  buttons: [],
  statusBar: { enabled: true },
};

const now = Date.now();

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
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

function live(overrides: Partial<ClaudeLiveState> = {}): ClaudeLiveState {
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

describe("separator collapse", () => {
  it("drops a separator between two values when one is missing", () => {
    const s = snapshot({ git: null });
    assert.equal(format("{workspace} — {branch}", s, config), "my-project");
  });

  it("keeps both when both resolve", () => {
    assert.equal(format("{workspace} — {branch}", snapshot(), config), "my-project — main");
  });

  it("strips a trailing separator when the variable ends the template", () => {
    // "Claude Code — {claudeActivity}" with no plugin installed.
    assert.equal(format("Claude Code — {claudeActivity}", snapshot(), config), "Claude Code");
  });

  it("strips a leading separator", () => {
    assert.equal(format("— {branch}", snapshot({ git: null }), config), "");
  });
});

describe("claude live variables", () => {
  it("renders tool and target as one phrase", () => {
    const s = snapshot({ claudeLive: live() });
    assert.equal(format("Claude Code — {claudeActivity}", s, config), "Claude Code — editing client.ts");
  });

  it("falls back to the verb alone when there is no target", () => {
    const s = snapshot({ claudeLive: live({ activity: { tool: "Task", verb: "delegating", target: null } }) });
    assert.equal(format("{claudeActivity}", s, config), "delegating");
  });

  it("exposes tokens and model", () => {
    const s = snapshot({ claudeLive: live() });
    assert.equal(format("{model} {tokensIn}/{tokensOut} {contextPercent}%", s, config), "Opus 15500/1200 8%");
  });

  it("omits tokens when showTokens is off", () => {
    const s = snapshot({ claudeLive: live() });
    const off = { ...config, claudeCode: { ...config.claudeCode, showTokens: false } };
    assert.equal(format("{tokensIn}", s, off), "");
  });
});

describe("privacy", () => {
  it("hides a target matching ignoredFiles", () => {
    const s = snapshot({ claudeLive: live({ activity: { tool: "Read", verb: "reading", target: ".env" } }) });
    assert.equal(format("{claudeActivity}", s, config), "reading");
  });

  it("hides the target under hideFileNames but keeps the verb", () => {
    const s = snapshot({ claudeLive: live() });
    const mode = { ...config, privacy: { ...config.privacy, mode: "hideFileNames" as const } };
    assert.equal(format("{claudeActivity}", s, mode), "editing");
  });

  it("suppresses the session title under hideWorkspace, since it comes from the prompt", () => {
    const s = snapshot({ claudeLive: live() });
    const mode = { ...config, privacy: { ...config.privacy, mode: "hideWorkspace" as const } };
    assert.equal(format("{sessionTitle}", s, mode), "");
  });
});

describe("clampField", () => {
  it("omits an empty field rather than sending an empty string", () => {
    assert.equal(clampField("   "), undefined);
  });

  it("pads a one-character result, which Discord rejects", () => {
    assert.equal(clampField("x"), "x ");
  });

  it("truncates on a byte budget, not a character count", () => {
    const clamped = clampField("é".repeat(200))!;
    assert.ok(Buffer.byteLength(clamped, "utf8") <= 128);
    assert.ok(clamped.endsWith("…"));
  });
});
