import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hasScope, sessionScopes } from "../../packages/libclaudebox/mcp/base.ts";

describe("session scopes", () => {
  it("sessionScopes is a Set", () => {
    assert.ok(sessionScopes instanceof Set);
  });

  it("hasScope returns false for ungranted scopes", () => {
    assert.equal(hasScope("create-external-pr"), false);
    assert.equal(hasScope("some-random-scope"), false);
  });

  it("hasScope returns false for empty string", () => {
    assert.equal(hasScope(""), false);
  });

  it("parses CLAUDEBOX_SCOPES from env", () => {
    // The env was not set in test setup, so scopes should be empty
    assert.equal(sessionScopes.size, 0);
  });
});
