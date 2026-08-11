import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { fromHook, statusLineText } from "./bridge.mjs";

/**
 * The bridge's contract with the extension is the `activity` field, and the
 * whole of it is *when the field is absent*. `merge` writes only defined keys,
 * so "no activity key" means hold what's there and "activity: null" would wipe
 * it. Getting that backwards is invisible in a diff and very visible on the card.
 */

const base = { session_id: "s1", cwd: "/w" };

describe("activity lifecycle", () => {
  it("reports the tool on PreToolUse", () => {
    const out = fromHook({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/w/src/build.ts" },
    });
    assert.deepEqual(
      { tool: out.activity.tool, verb: out.activity.verb, target: out.activity.target },
      { tool: "Edit", verb: "editing", target: "build.ts" },
    );
  });

  it("holds the last tool through PostToolUse by omitting the field", () => {
    const out = fromHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    assert.ok(!("activity" in out), "PostToolUse must not write activity at all");
  });

  it("does not blank the activity when a tool fails either", () => {
    const out = fromHook({ ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash" });
    assert.ok(!("activity" in out));
  });

  it("switches to thinking when the turn ends", () => {
    const out = fromHook({ ...base, hook_event_name: "Stop" });
    assert.equal(out.activity.tool, null);
    assert.equal(out.activity.verb, "thinking");
    assert.equal(out.activity.target, null);
  });

  it("starts a session with no activity", () => {
    const out = fromHook({ ...base, hook_event_name: "SessionStart", model: "Opus 5" });
    assert.equal(out.activity, null);
    assert.equal(typeof out.startedAt, "number");
  });

  it("carries the parent pid, which is how the extension reaps dead sessions", () => {
    const out = fromHook({ ...base, hook_event_name: "Stop" });
    assert.equal(out.pid, process.ppid);
  });
});

describe("status line", () => {
  it("renders the thinking state without a dangling target", () => {
    const text = statusLineText({
      model: "Opus 5",
      activity: { tool: null, verb: "thinking", target: null },
      tokens: { input: 72015, output: 199, usedPercentage: 7 },
    });
    assert.equal(text, "Opus 5  ·  thinking  ·  72.2K tok · 7% ctx");
  });
});
