import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assetForLanguage } from "./assets.js";
import { build } from "./build.js";
import { config, editor, live, now, snapshot } from "../testing/fixtures.js";

/**
 * Golden payloads. `format` proves the strings; this proves the whole object
 * Discord actually receives — which field each string lands in, which fields are
 * omitted rather than sent empty, and which timestamp the timer counts from.
 *
 * Assertions are on the full object, not a field at a time: a payload that
 * gained a field nobody meant to send should fail here.
 */

// Derived, not spelled out: the pinned ref moves every release, and a golden
// test that hardcodes it fails on the version bump rather than on a real change.
// What matters here is which key each payload carries, not the CDN path.
const ICON = assetForLanguage("plaintext").key.replace(/\/file\.png$/, "");

describe("claude code payload", () => {
  const base = snapshot({
    editor: editor(),
    claudeLive: live(),
    sessionStartedAt: now - 3 * 3_600_000 - 12 * 60_000,
  });

  it("is the full card: activity, title, tokens, uptime, session timer", () => {
    assert.deepEqual(build(base, config), {
      type: 0,
      details: "Claude Code — editing client.ts",
      state: "add rate limiting · 15.5K in / 1.2K out · 8% ctx · up 3h 12m",
      startTimestamp: now,
      largeImageKey: `${ICON}/cursor.png`,
      largeImageText: "Opus · 15.5K in / 1.2K out · 8% ctx",
      smallImageKey: `${ICON}/claude.png`,
      smallImageText: "Cursor — build.ts",
    });
  });

  it("counts from the session start, not from when the extension noticed", () => {
    const s = snapshot({
      claudeLive: live({ startedAt: now - 90 * 60_000 }),
      claudeCode: { sessions: 1, since: now - 60_000 },
    });
    assert.equal(build(s, config)!.startTimestamp, now - 90 * 60_000);
  });

  it("holds the last tool between calls, so line 1 never reads bare", () => {
    const s = snapshot({ claudeLive: live({ activity: { tool: null, verb: "thinking", target: null } }) });
    assert.equal(build(s, config)!.details, "Claude Code — thinking");
  });

  it("borrows the editing line when a session has no title and no tokens", () => {
    // The plugin is installed but the token tier isn't — line 2 would be empty.
    const s = snapshot({
      editor: editor(),
      claudeLive: live({ sessionTitle: null, tokens: null }),
    });
    assert.equal(build(s, config)!.state, "my-project — main");
  });

  it("omits the timer entirely when elapsed time is off", () => {
    const off = { ...config, showElapsedTime: false };
    assert.equal("startTimestamp" in build(base, off)!, false);
  });

  it("falls back to the badge's own label when no file is open", () => {
    const s = snapshot({ editor: null, claudeLive: live() });
    assert.equal(build(s, config)!.smallImageText, "Claude Code");
  });
});

describe("payload under privacy modes", () => {
  const s = snapshot({ editor: editor(), claudeLive: live() });

  it("hideFileNames keeps the verb but names no file anywhere", () => {
    const activity = build(s, {
      ...config,
      privacy: { ...config.privacy, mode: "hideFileNames" },
    })!;
    assert.equal(activity.details, "Claude Code — editing");
    assert.equal(activity.smallImageText, "Claude Code");
    for (const field of [activity.details, activity.state, activity.smallImageText]) {
      assert.ok(!(field ?? "").includes("client.ts"));
      assert.ok(!(field ?? "").includes("build.ts"));
    }
  });

  it("minimal drops the title, leaving tokens — which name nothing", () => {
    const activity = build(s, { ...config, privacy: { ...config.privacy, mode: "minimal" } })!;
    assert.equal(activity.state, "15.5K in / 1.2K out · 8% ctx · up 0m");
    assert.equal(activity.largeImageKey, `${ICON}/cursor.png`);
  });

  it("drops a Claude target matching ignoredFiles", () => {
    // The user's own open file is redacted upstream by editor.ts, which
    // substitutes "a file" before the name ever reaches a snapshot. Claude's
    // target arrives from the plugin unfiltered, so it is filtered here.
    const secret = snapshot({
      editor: editor({ fileName: "a file", relPath: "a file" }),
      claudeLive: live({ activity: { tool: "Read", verb: "reading", target: ".env" } }),
    });
    const activity = build(secret, config)!;
    assert.equal(activity.details, "Claude Code — reading");
    assert.equal(activity.smallImageText, "Cursor — a file");
  });
});

describe("other states", () => {
  it("editing renders file and workspace", () => {
    const s = snapshot({ editor: editor() });
    assert.deepEqual(build(s, config), {
      type: 0,
      details: "Editing build.ts",
      state: "my-project — main",
      startTimestamp: now,
      largeImageKey: `${ICON}/cursor.png`,
      largeImageText: "Cursor",
      smallImageKey: `${ICON}/typescript.png`,
      smallImageText: "TypeScript",
    });
  });

  it("carries no claude hover text outside a claude session", () => {
    const s = snapshot({ editor: editor(), cursorAi: { active: true, since: now, confidence: 1 } });
    assert.equal(build(s, config)!.largeImageText, "Cursor");
  });

  it("drops the badge when there is no AI and no language to put in it", () => {
    // `minimal` withholds the language, and the large image is already Cursor —
    // a second Cursor mark in the badge would say nothing.
    const s = snapshot({ editor: editor() });
    const activity = build(s, { ...config, privacy: { ...config.privacy, mode: "minimal" } })!;
    assert.equal("smallImageKey" in activity, false);
  });

  it("clears the presence when disabled", () => {
    assert.equal(build(snapshot({ editor: editor() }), { ...config, enabled: false }), null);
  });

  it("clears the presence when idle and configured to", () => {
    const idle = snapshot({ editor: editor(), lastInputAt: now - 3_600_000 });
    assert.equal(build(idle, { ...config, idleBehavior: "clearPresence" }), null);
  });
});

describe("buttons", () => {
  it("drops a {repoUrl} button when the workspace has no remote", () => {
    const buttons = [{ label: "Repo", url: "{repoUrl}" }];
    assert.equal("buttons" in build(snapshot({ editor: editor() }), { ...config, buttons })!, false);
  });

  it("renders it when a remote exists", () => {
    const s = snapshot({
      editor: editor(),
      git: { branch: "main", repoName: "my-project", remoteUrl: "https://github.com/a/b" },
    });
    const buttons = [{ label: "Repo", url: "{repoUrl}" }];
    assert.deepEqual(build(s, { ...config, buttons })!.buttons, [
      { label: "Repo", url: "https://github.com/a/b" },
    ]);
  });
});
