import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";



import {
  truncate, extractHashFromUrl, parseMessage, parseKeywords,
  validateResumeSession, sessionUrl, worktreeIdFromLogUrl,
  hashFromLogUrl, prKeyFromUrl,
} from "../../packages/libclaudebox/util.ts";
import type { SessionMeta, ParseResult } from "../../packages/libclaudebox/types.ts";

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    assert.equal(truncate("hello", 80), "hello");
  });

  it("truncates long strings with ellipsis", () => {
    const long = "a".repeat(100);
    const result = truncate(long, 20);
    assert.equal(result.length, 20);
    assert.ok(result.endsWith("..."));
  });

  it("handles exact boundary", () => {
    const s = "a".repeat(80);
    assert.equal(truncate(s, 80), s);
  });

  it("uses default limit of 80", () => {
    const s = "a".repeat(81);
    assert.equal(truncate(s).length, 80);
  });
});

describe("extractHashFromUrl", () => {
  it("extracts hash from log URL", () => {
    assert.equal(
      extractHashFromUrl("http://ci.example.com/abc123def456-3"),
      "abc123def456-3",
    );
  });

  it("extracts hash from angle-bracketed URL", () => {
    assert.equal(
      extractHashFromUrl("<http://ci.example.com/abc123def456-3>"),
      "abc123def456-3",
    );
  });

  it("extracts legacy 32-hex hash", () => {
    const hash = "a".repeat(32);
    assert.equal(
      extractHashFromUrl(`http://ci.example.com/${hash}`),
      hash,
    );
  });

  it("returns null for non-matching URLs", () => {
    assert.equal(extractHashFromUrl("http://other-site.com/abc123"), null);
    assert.equal(extractHashFromUrl("just some text"), null);
    assert.equal(extractHashFromUrl(""), null);
  });

  it("handles https variant", () => {
    assert.equal(
      extractHashFromUrl("https://ci.example.com/abc123def456-3"),
      "abc123def456-3",
    );
  });
});

describe("parseMessage", () => {
  const noSession = (_: string) => null;
  const alwaysSession = (_: string) => ({ status: "completed", worktree_id: "wt1" } as SessionMeta);

  it("returns plain prompt for normal text", () => {
    const result = parseMessage("please fix the bug", noSession);
    assert.deepEqual(result, { type: "prompt", prompt: "please fix the bug" });
  });

  it("extracts hash from log URL with remaining prompt", () => {
    const result = parseMessage("http://ci.example.com/abc123-1 fix this", noSession);
    assert.equal(result.type, "reply-hash");
    if (result.type === "reply-hash") {
      assert.equal(result.hash, "abc123-1");
      assert.equal(result.prompt, "fix this");
    }
  });

  it("recognizes worktree-seq format when session exists", () => {
    const result = parseMessage("d9441073aae158ae-1 continue", alwaysSession);
    assert.equal(result.type, "reply-hash");
    if (result.type === "reply-hash") {
      assert.equal(result.hash, "d9441073aae158ae-1");
      assert.equal(result.prompt, "continue");
    }
  });

  it("does not match worktree-seq if no session found", () => {
    const result = parseMessage("d9441073aae158ae-1 continue", noSession);
    assert.equal(result.type, "prompt");
  });

  it("recognizes legacy 32-hex hash when session exists", () => {
    const hash = "a".repeat(32);
    const result = parseMessage(`${hash} do stuff`, alwaysSession);
    assert.equal(result.type, "reply-hash");
  });
});

describe("parseKeywords", () => {
  const base: ParseResult = { type: "prompt", prompt: "" };

  it("detects new-session keyword", () => {
    const result = parseKeywords({ ...base, prompt: "new-session fix the bug" });
    assert.equal(result.forceNew, true);
    assert.equal(result.prompt, "fix the bug");
  });

  it("detects quiet keyword", () => {
    const result = parseKeywords({ ...base, prompt: "quiet do stuff" });
    assert.equal(result.quiet, true);
    assert.equal(result.prompt, "do stuff");
  });

  it("detects loud keyword", () => {
    const result = parseKeywords({ ...base, prompt: "loud do stuff" });
    assert.equal(result.quiet, false);
    assert.equal(result.prompt, "do stuff");
  });

  it("detects ci-allow keyword", () => {
    const result = parseKeywords({ ...base, prompt: "ci-allow deploy it" });
    assert.equal(result.ciAllow, true);
    assert.equal(result.prompt, "deploy it");
  });

  it("detects allow-ci variant", () => {
    const result = parseKeywords({ ...base, prompt: "allow-ci deploy it" });
    assert.equal(result.ciAllow, true);
  });

  it("handles multiple keywords in any order", () => {
    const result = parseKeywords({ ...base, prompt: "quiet new-session ci-allow do the thing" });
    assert.equal(result.forceNew, true);
    assert.equal(result.quiet, true);
    assert.equal(result.ciAllow, true);
    assert.equal(result.prompt, "do the thing");
  });

  it("is case insensitive", () => {
    const result = parseKeywords({ ...base, prompt: "NEW-SESSION Quiet FIX BUG" });
    assert.equal(result.forceNew, true);
    assert.equal(result.quiet, true);
    assert.equal(result.prompt, "FIX BUG");
  });

  it("leaves prompt untouched when no keywords", () => {
    const result = parseKeywords({ ...base, prompt: "just a normal prompt" });
    assert.equal(result.forceNew, false);
    assert.equal(result.quiet, null);
    assert.equal(result.ciAllow, false);
    assert.equal(result.profile, "");
    assert.equal(result.prompt, "just a normal prompt");
  });
});

describe("validateResumeSession", () => {
  it("returns error for null session", () => {
    const err = validateResumeSession(null, "abc123");
    assert.ok(err);
    assert.ok(err.includes("not found"));
  });

  it("returns error for running session", () => {
    const err = validateResumeSession({ status: "running", worktree_id: "wt1" } as SessionMeta, "abc123");
    assert.ok(err);
    assert.ok(err.includes("still running"));
  });

  it("returns error for session without worktree", () => {
    const err = validateResumeSession({ status: "completed" } as SessionMeta, "abc123");
    assert.ok(err);
    assert.ok(err.includes("no worktree"));
  });

  it("returns null for valid resumable session", () => {
    assert.equal(
      validateResumeSession({ status: "completed", worktree_id: "wt1" } as SessionMeta, "abc123"),
      null,
    );
  });
});

describe("sessionUrl", () => {
  it("builds URL from worktree ID", () => {
    assert.equal(sessionUrl("abc123"), "https://claudebox.test/s/abc123");
  });
});

describe("worktreeIdFromLogUrl", () => {
  it("extracts worktree ID from new format", () => {
    assert.equal(
      worktreeIdFromLogUrl("http://ci.example.com/d9441073aae158ae-3"),
      "d9441073aae158ae",
    );
  });

  it("returns empty string for legacy format", () => {
    assert.equal(
      worktreeIdFromLogUrl("http://ci.example.com/" + "a".repeat(32)),
      "",
    );
  });
});

describe("hashFromLogUrl", () => {
  it("extracts full log ID", () => {
    assert.equal(
      hashFromLogUrl("http://ci.example.com/d9441073aae158ae-3"),
      "d9441073aae158ae-3",
    );
  });

  it("returns empty string for non-matching URL", () => {
    assert.equal(hashFromLogUrl("http://example.com/"), "");
  });
});

describe("prKeyFromUrl", () => {
  it("extracts PR key from GitHub URL", () => {
    assert.equal(
      prKeyFromUrl("https://github.com/AztecProtocol/aztec-packages/pull/1234"),
      "AztecProtocol/aztec-packages#1234",
    );
  });

  it("returns null for non-PR URLs", () => {
    assert.equal(prKeyFromUrl("https://github.com/foo/bar/issues/5"), null);
    assert.equal(prKeyFromUrl("https://example.com"), null);
  });
});
