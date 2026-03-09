import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isGhAllowed, buildCommonGhWhitelist } from "../../packages/libclaudebox/mcp/helpers.ts";

const R = "repos/TestOrg/test-repo";
const whitelist = buildCommonGhWhitelist(R);

describe("buildCommonGhWhitelist", () => {
  it("returns an array of route patterns", () => {
    assert.ok(Array.isArray(whitelist));
    assert.ok(whitelist.length > 10, "should have many whitelisted patterns");
    for (const entry of whitelist) {
      assert.ok(entry.method, "entry must have a method");
      assert.ok(entry.pattern instanceof RegExp, "entry must have a pattern");
    }
  });
});

describe("isGhAllowed", () => {
  describe("pulls", () => {
    it("allows GET pulls list", () => {
      assert.ok(isGhAllowed("GET", `${R}/pulls?state=open`, whitelist));
    });

    it("allows GET single pull", () => {
      assert.ok(isGhAllowed("GET", `${R}/pulls/123`, whitelist));
    });

    it("allows GET pull files", () => {
      assert.ok(isGhAllowed("GET", `${R}/pulls/123/files`, whitelist));
    });

    it("blocks POST to pulls (no write)", () => {
      assert.ok(!isGhAllowed("POST", `${R}/pulls`, whitelist));
    });
  });

  describe("issues", () => {
    it("allows GET issues list", () => {
      assert.ok(isGhAllowed("GET", `${R}/issues?state=open`, whitelist));
    });

    it("allows GET single issue", () => {
      assert.ok(isGhAllowed("GET", `${R}/issues/42`, whitelist));
    });

    it("allows GET issue comments", () => {
      assert.ok(isGhAllowed("GET", `${R}/issues/42/comments`, whitelist));
    });

    it("blocks POST to issues (no write via generic API)", () => {
      assert.ok(!isGhAllowed("POST", `${R}/issues`, whitelist));
    });
  });

  describe("contents and branches", () => {
    it("allows GET contents", () => {
      assert.ok(isGhAllowed("GET", `${R}/contents/src/main.ts`, whitelist));
    });

    it("allows GET branches", () => {
      assert.ok(isGhAllowed("GET", `${R}/branches`, whitelist));
    });

    it("allows GET single branch", () => {
      assert.ok(isGhAllowed("GET", `${R}/branches/main`, whitelist));
    });

    it("allows GET commits", () => {
      assert.ok(isGhAllowed("GET", `${R}/commits`, whitelist));
    });
  });

  describe("CI / actions", () => {
    it("allows GET actions runs", () => {
      assert.ok(isGhAllowed("GET", `${R}/actions/runs`, whitelist));
    });

    it("allows GET actions run jobs", () => {
      assert.ok(isGhAllowed("GET", `${R}/actions/runs/12345/jobs`, whitelist));
    });

    it("allows GET check-runs", () => {
      assert.ok(isGhAllowed("GET", `${R}/check-runs/999/annotations`, whitelist));
    });
  });

  describe("gists", () => {
    it("allows GET gists list", () => {
      assert.ok(isGhAllowed("GET", "gists", whitelist));
    });

    it("allows GET gists with pagination", () => {
      assert.ok(isGhAllowed("GET", "gists?per_page=100&page=2", whitelist));
    });

    it("allows GET single gist by ID", () => {
      assert.ok(isGhAllowed("GET", "gists/abc123def456", whitelist));
    });

    it("blocks POST to gists (handled by create_gist tool)", () => {
      assert.ok(!isGhAllowed("POST", "gists", whitelist));
    });
  });

  describe("search", () => {
    it("allows search issues", () => {
      assert.ok(isGhAllowed("GET", "search/issues?q=repo:TestOrg/test-repo", whitelist));
    });

    it("allows search code", () => {
      assert.ok(isGhAllowed("GET", "search/code?q=function", whitelist));
    });
  });

  describe("blocks unknown paths", () => {
    it("blocks DELETE requests", () => {
      assert.ok(!isGhAllowed("DELETE", `${R}/issues/1`, whitelist));
    });

    it("blocks unknown endpoints", () => {
      assert.ok(!isGhAllowed("GET", `${R}/stargazers`, whitelist));
    });

    it("blocks cross-repo access", () => {
      assert.ok(!isGhAllowed("GET", "repos/OtherOrg/other-repo/issues", whitelist));
    });
  });

  describe("leading slash handling", () => {
    it("strips leading slash before matching", () => {
      assert.ok(isGhAllowed("GET", `/${R}/pulls`, whitelist));
    });
  });
});
