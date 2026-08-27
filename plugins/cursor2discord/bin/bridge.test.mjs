import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { fromHook, fromStatusLine, shouldRefreshCopy, statusLineText, targetOf } from "./bridge.mjs";

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

describe("fromStatusLine", () => {
  it("never writes a pid — its own parent is a shell that is about to exit", () => {
    // Stamping it here reaped the session between turns: hooks kept the real
    // pid while a tool ran, and the next status line replaced it with a corpse.
    assert.equal("pid" in fromStatusLine({ session_name: "s", workspace: { current_dir: "/w" } }), false);
  });
});

describe("targetOf", () => {
  const cases = [
    ["Edit", { file_path: "/w/src/build.ts" }, "build.ts"],
    ["Write", { file_path: "/w/.env" }, ".env"],
    ["NotebookEdit", { notebook_path: "/w/a.ipynb" }, "a.ipynb"],
    ["Bash", { command: "npm run build -- --watch" }, "npm run"],
    ["Bash", { command: "git commit -m 'x'" }, "git commit"],
    ["Bash", { command: "ls" }, "ls"],
    ["Bash", { command: "/usr/local/bin/node script.mjs" }, "node"],
    ["Grep", { pattern: "sk-live-abc", path: "/w/src" }, "src"],
    ["Glob", { pattern: "**/*.ts" }, null],
    ["Task", { subagent_type: "reviewer", prompt: "secret plan" }, "reviewer"],
    ["WebFetch", { url: "https://www.example.com/p?token=abc" }, "example.com"],
    ["WebSearch", { query: "how do I rotate my aws key" }, null],
    ["TodoWrite", { todos: [{ content: "ship it" }] }, null],
  ];

  for (const [tool, input, expected] of cases) {
    it(`${tool} ${JSON.stringify(input).slice(0, 44)} → ${expected}`, () => {
      assert.equal(targetOf(input, tool), expected);
    });
  }
});

/**
 * The load-bearing half. Everything below is a real shape of secret that has
 * appeared in somebody's command line or search, and none of it may reach a
 * chat server. A failure here is a disclosure, not a cosmetic bug.
 */
describe("targetOf never leaks user content", () => {
  const leaks = [
    ["Bash", { command: "curl -H 'Authorization: Bearer sk-live-abc' https://api.x" }, "curl"],
    // The binary survives; the assignment carrying the key does not.
    ["Bash", { command: "ANTHROPIC_API_KEY=sk-ant-123 claude -p 'hi'" }, "claude"],
    ["Bash", { command: "psql postgres://user:hunter2@db.internal/prod" }, "psql"],
    ["Bash", { command: "ssh deploy@10.0.0.4 'cat /etc/shadow'" }, "ssh"],
    ["Bash", { command: "echo $STRIPE_SECRET | base64" }, "echo"],
    ["Grep", { pattern: "AKIA[0-9A-Z]{16}", path: "/w/infra" }, "infra"],
    ["Grep", { pattern: "password" }, null],
    ["Task", { prompt: "the customer list is attached" }, null],
    ["WebFetch", { url: "https://api.example.com/v1/keys?token=sk-live-abc" }, "api.example.com"],
  ];

  for (const [tool, input, expected] of leaks) {
    it(`${tool}: ${Object.values(input)[0].toString().slice(0, 46)}`, () => {
      const target = targetOf(input, tool);
      assert.equal(target, expected);
      // Belt and braces: whatever came back, it isn't a fragment of the input.
      const secrets = ["sk-live-abc", "sk-ant-123", "hunter2", "AKIA", "shadow", "STRIPE", "customer"];
      for (const secret of secrets) {
        assert.ok(!(target ?? "").includes(secret), `leaked ${secret}`);
      }
    });
  }
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

/**
 * The status line runs a *copy* of this file, because `${CLAUDE_PLUGIN_ROOT}`
 * is undefined in that context. A copy that never refreshes is a fork, and a
 * silent one — it keeps exiting 0 long after the schema has moved past it.
 */
describe("token tier copy", () => {
  it("refreshes a copy the plugin has moved past", () => {
    assert.equal(shouldRefreshCopy("/plugin/bridge.mjs", "/home/bridge.mjs", "old", "new"), true);
  });

  it("leaves an up-to-date copy alone", () => {
    assert.equal(shouldRefreshCopy("/plugin/bridge.mjs", "/home/bridge.mjs", "same", "same"), false);
  });

  it("never writes a file onto itself", () => {
    // The copy runs in statusline mode from this same path; without the guard
    // it would rewrite itself while Claude Code is reading its output.
    assert.equal(shouldRefreshCopy("/home/bridge.mjs", "/home/bridge.mjs", "a", "b"), false);
  });
});
