import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { classify, isActive, type EditWindow } from "./aiHeuristic.js";

function window(overrides: Partial<EditWindow> = {}): EditWindow {
  return {
    insertedLength: 0,
    fileCount: 1,
    changeCount: 1,
    msSinceKeyboard: null,
    msSinceWillSave: null,
    msSinceHeadChange: null,
    chatTabOpen: false,
    singleInsertAtOneSelection: false,
    ...overrides,
  };
}

describe("detects AI-shaped edits", () => {
  it("a large insert with no recent keystroke", () => {
    assert.ok(isActive(classify(window({ insertedLength: 400, changeCount: 2 }))));
  });

  it("a multi-file edit with a chat tab open", () => {
    assert.ok(
      isActive(classify(window({ fileCount: 3, changeCount: 5, insertedLength: 40, chatTabOpen: true }))),
    );
  });

  it("scores a large multi-file burst near certainty", () => {
    const score = classify(window({ insertedLength: 2000, fileCount: 4, changeCount: 9, chatTabOpen: true }));
    assert.ok(score >= 0.95, `expected high confidence, got ${score}`);
  });
});

describe("does not fire on human editing", () => {
  it("typing", () => {
    // The reason this matters: normal typing must never read as an agent.
    assert.equal(classify(window({ insertedLength: 200, msSinceKeyboard: 50 })), 0);
  });

  it("a small edit with no other signal", () => {
    assert.equal(classify(window({ insertedLength: 10, changeCount: 1 })), 0);
  });
});

describe("suppressions", () => {
  it("format-on-save", () => {
    assert.equal(classify(window({ insertedLength: 5000, fileCount: 1, msSinceWillSave: 200 })), 0);
  });

  it("branch switch", () => {
    assert.equal(classify(window({ insertedLength: 9000, fileCount: 20, msSinceHeadChange: 500 })), 0);
  });

  it("rename-symbol with no chat panel open", () => {
    assert.equal(
      classify(window({ fileCount: 5, changeCount: 5, insertedLength: 60, msSinceKeyboard: 400, chatTabOpen: false })),
      0,
    );
  });

  it("but the same shape counts when a chat panel is open", () => {
    assert.ok(
      isActive(
        classify(window({ fileCount: 5, changeCount: 5, insertedLength: 60, msSinceKeyboard: 400, chatTabOpen: true })),
      ),
    );
  });

  it("paste — one insert at one cursor", () => {
    assert.equal(
      classify(window({ insertedLength: 3000, fileCount: 1, changeCount: 1, singleInsertAtOneSelection: true })),
      0,
    );
  });
});
