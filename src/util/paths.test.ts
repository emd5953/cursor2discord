import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { belongsTo } from "./paths.js";

describe("belongsTo", () => {
  it("matches the folder itself", () => {
    assert.equal(belongsTo("/work/app", "/work/app"), true);
  });

  it("matches a subdirectory", () => {
    assert.equal(belongsTo("/work/app/src/deep", "/work/app"), true);
  });

  it("does not match a sibling with a shared prefix", () => {
    // The bug this guards: a naive startsWith puts /work/app2's session on
    // /work/app's presence.
    assert.equal(belongsTo("/work/app2", "/work/app"), false);
  });

  it("normalises traversal and trailing separators", () => {
    assert.equal(belongsTo("/work/app/src/..", "/work/app/"), true);
    assert.equal(belongsTo("/work/app/../other", "/work/app"), false);
  });

  it("is false for a missing cwd", () => {
    assert.equal(belongsTo(null, "/work/app"), false);
    assert.equal(belongsTo(undefined, "/work/app"), false);
  });
});
