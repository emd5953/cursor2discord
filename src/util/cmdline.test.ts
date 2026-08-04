import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { matchesCommand, nameMatchesCommand, parseCommand } from "./cmdline.js";

const COMMANDS = ["claude", "claude-code"];

describe("parseCommand", () => {
  it("strips leading environment assignments", () => {
    assert.equal(parseCommand("ANTHROPIC_API_KEY=x claude -p hi")?.bin, "claude");
  });

  it("strips wrappers and their flags", () => {
    assert.equal(parseCommand("sudo -E claude")?.bin, "claude");
    assert.equal(parseCommand("nohup time claude")?.bin, "claude");
  });

  it("resolves package runners", () => {
    assert.equal(parseCommand("npx claude@latest")?.bin, "claude");
    assert.equal(parseCommand("pnpm dlx claude")?.bin, "claude");
    assert.equal(parseCommand("bun x claude")?.bin, "claude");
  });

  it("basenames absolute paths and strips windows extensions", () => {
    assert.equal(parseCommand("/usr/local/bin/claude --resume")?.bin, "claude");
    assert.equal(parseCommand("C:\\tools\\claude.exe")?.bin, "claude");
  });

  it("stops at a pipeline boundary", () => {
    assert.equal(parseCommand("echo hi | claude")?.bin, "echo");
  });

  it("returns null for an empty line", () => {
    assert.equal(parseCommand("   "), null);
  });
});

describe("matchesCommand", () => {
  // SPEC.md §Claude Code detection lists these explicitly.
  const mustMatch = [
    "claude",
    "claude --resume",
    "npx claude@latest",
    'ANTHROPIC_API_KEY=x claude -p "summarise this"',
    "claude-code",
    "env FOO=1 claude",
  ];

  const mustNotMatch = [
    'git commit -m "claude"',
    "echo claude",
    "vim claude.md",
    "npm run claude",
    "./claude-notes.sh",
    "grep claude src/",
  ];

  for (const line of mustMatch) {
    it(`matches: ${line}`, () => assert.equal(matchesCommand(line, COMMANDS), true));
  }

  for (const line of mustNotMatch) {
    it(`ignores: ${line}`, () => assert.equal(matchesCommand(line, COMMANDS), false));
  }
});

describe("nameMatchesCommand", () => {
  it("matches a terminal renamed after the process", () => {
    assert.equal(nameMatchesCommand("claude", COMMANDS), true);
    assert.equal(nameMatchesCommand("claude --resume", COMMANDS), true);
  });

  it("does not match a merely similar name", () => {
    assert.equal(nameMatchesCommand("claude-notes", COMMANDS), false);
    assert.equal(nameMatchesCommand("zsh", COMMANDS), false);
  });
});
