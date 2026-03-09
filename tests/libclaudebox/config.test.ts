import { describe, it } from "node:test";
import assert from "node:assert/strict";


import {
  buildLogUrl, setChannelMaps, getChannelBranches, getChannelProfiles,
  DEFAULT_BASE_BRANCH, LOG_BASE_URL, CLAUDEBOX_HOST, SESSION_PAGE_PASS,
} from "../../packages/libclaudebox/config.ts";

describe("config", () => {
  it("reads CLAUDEBOX_LOG_BASE_URL from env", () => {
    // Falls back to http://<CLAUDEBOX_HOST> when env not set
    assert.ok(LOG_BASE_URL.startsWith("http"));
  });

  it("reads CLAUDEBOX_HOST from env", () => {
    // Falls back to localhost:3000 when env not set
    assert.ok(typeof CLAUDEBOX_HOST === "string" && CLAUDEBOX_HOST.length > 0);
  });

  it("reads CLAUDEBOX_SESSION_PASS from env", () => {
    assert.equal(typeof SESSION_PAGE_PASS, "string");
  });

  it("reads DEFAULT_BASE_BRANCH from env", () => {
    assert.equal(DEFAULT_BASE_BRANCH, "main");
  });
});

describe("buildLogUrl", () => {
  it("constructs URL from base and logId", () => {
    assert.equal(buildLogUrl("abc123-1"), `${LOG_BASE_URL}/abc123-1`);
  });
});

describe("channel maps", () => {
  it("starts with empty maps", () => {
    // Reset maps
    setChannelMaps({}, {});
    assert.deepEqual(getChannelBranches(), {});
    assert.deepEqual(getChannelProfiles(), {});
  });

  it("setChannelMaps populates maps", () => {
    setChannelMaps(
      { "honk-team": "merge-train/barretenberg" },
      { "C0AJCUKUNGP": "barretenberg-audit" },
    );
    assert.equal(getChannelBranches()["honk-team"], "merge-train/barretenberg");
    assert.equal(getChannelProfiles()["C0AJCUKUNGP"], "barretenberg-audit");
  });

  it("setChannelMaps replaces previous maps", () => {
    setChannelMaps({ a: "1" }, { b: "2" });
    setChannelMaps({ c: "3" }, { d: "4" });
    assert.equal(getChannelBranches()["a"], undefined);
    assert.equal(getChannelBranches()["c"], "3");
  });
});
