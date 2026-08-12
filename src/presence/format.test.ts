import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { clampField, format } from "./format.js";
import { config, live, now, snapshot } from "../testing/fixtures.js";

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

  it("renders a running tool while one is running", () => {
    const s = snapshot({ claudeLive: live() });
    assert.equal(format("{claudeActivity}", s, config, now), "editing client.ts");
  });

  it("renders the between-turns state, where there is a verb but no tool", () => {
    const s = snapshot({
      claudeLive: live({ activity: { tool: null, verb: "thinking", target: null } }),
    });
    assert.equal(format("Claude Code — {claudeActivity}", s, config, now), "Claude Code — thinking");
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

describe("token summary and durations", () => {
  const STATE = "{sessionTitle} · {tokenSummary} · up {cursorUptime}";

  it("renders the shipped default line 2 in full", () => {
    const s = snapshot({ claudeLive: live(), sessionStartedAt: now - 3 * 3_600_000 - 12 * 60_000 });
    assert.equal(
      format(STATE, s, config, now),
      "add rate limiting · 15.5K in / 1.2K out · 8% ctx · up 3h 12m",
    );
  });

  it("stays inside the 128-byte line budget", () => {
    const s = snapshot({ claudeLive: live() });
    assert.ok(Buffer.byteLength(format(STATE, s, config, now), "utf8") <= 128);
  });

  it("collapses to the title alone without the token tier", () => {
    const s = snapshot({ claudeLive: live({ tokens: null }), sessionStartedAt: now });
    assert.equal(format("{sessionTitle} · {tokenSummary}", s, config, now), "add rate limiting");
  });

  it("drops the summary when showTokens is off, leaving no dangling separator", () => {
    const s = snapshot({ claudeLive: live() });
    const off = { ...config, claudeCode: { ...config.claudeCode, showTokens: false } };
    assert.equal(format("{sessionTitle} · {tokenSummary}", s, off, now), "add rate limiting");
  });

  it("compacts thousands and millions, but not hundreds", () => {
    const s = snapshot({
      claudeLive: live({ tokens: { input: 2_400_000, output: 999, usedPercentage: 94 } }),
    });
    assert.equal(format("{tokenSummary}", s, config, now), "2.4M in / 999 out · 94% ctx");
  });

  it("renders a sub-hour uptime without an hours part", () => {
    const s = snapshot({ sessionStartedAt: now - 12 * 60_000 });
    assert.equal(format("{cursorUptime}", s, config, now), "12m");
  });

  it("floors a fresh session to 0m rather than showing seconds", () => {
    const s = snapshot({ sessionStartedAt: now - 5_000 });
    assert.equal(format("{cursorUptime}", s, config, now), "0m");
  });

  it("tracks the Claude session separately from Cursor's uptime", () => {
    const s = snapshot({
      sessionStartedAt: now - 3 * 3_600_000,
      claudeLive: live({ startedAt: now - 63 * 60_000 }),
    });
    assert.equal(format("{cursorUptime}/{claudeUptime}", s, config, now), "3h 0m/1h 3m");
  });

  it("has no claude uptime without a live session", () => {
    assert.equal(format("{claudeUptime}", snapshot(), config, now), "");
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
