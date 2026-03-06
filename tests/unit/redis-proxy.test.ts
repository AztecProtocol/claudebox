/**
 * Unit tests for the Redis RESP protocol proxy.
 *
 * These tests exercise the command parsing, validation, and error formatting
 * logic directly — no TCP connections or upstream Redis needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateRedisKey,
  validateSetexTtl,
  checkCommand,
} from "../../sidecar/redis-proxy.ts";

// ── validateRedisKey ───────────────────────────────────────────────

describe("validateRedisKey", () => {
  it("accepts simple alphanumeric keys", () => {
    assert.equal(validateRedisKey("mykey"), null);
    assert.equal(validateRedisKey("cache:user:123"), null);
    assert.equal(validateRedisKey("build/artifact/v1.2.3"), null);
    assert.equal(validateRedisKey("some_key.json"), null);
  });

  it("rejects empty key", () => {
    assert.equal(validateRedisKey(""), "missing key");
  });

  it("rejects key longer than 256 chars", () => {
    assert.equal(validateRedisKey("a".repeat(257)), "key too long");
  });

  it("accepts key exactly 256 chars", () => {
    assert.equal(validateRedisKey("a".repeat(256)), null);
  });

  it("rejects keys with path traversal", () => {
    assert.equal(validateRedisKey("foo/../etc/passwd"), "path traversal in key");
    assert.equal(validateRedisKey(".."), "path traversal in key");
    assert.equal(validateRedisKey("a..b"), "path traversal in key");
  });

  it("rejects keys starting with /", () => {
    assert.equal(validateRedisKey("/etc/passwd"), "absolute path in key");
  });

  it("rejects keys with shell injection characters", () => {
    assert.notEqual(validateRedisKey("key; rm -rf /"), null);
    assert.notEqual(validateRedisKey("key$(whoami)"), null);
    assert.notEqual(validateRedisKey("key`id`"), null);
    assert.notEqual(validateRedisKey("key\nDEL other"), null);
    assert.notEqual(validateRedisKey("key with spaces"), null);
    assert.notEqual(validateRedisKey("key|pipe"), null);
  });

  it("rejects keys with special chars like * ? { } [ ]", () => {
    assert.notEqual(validateRedisKey("key*"), null);
    assert.notEqual(validateRedisKey("key?"), null);
    assert.notEqual(validateRedisKey("{key}"), null);
    assert.notEqual(validateRedisKey("[key]"), null);
  });
});

// ── validateSetexTtl ───────────────────────────────────────────────

describe("validateSetexTtl", () => {
  it("accepts valid TTLs", () => {
    assert.equal(validateSetexTtl("1"), null);
    assert.equal(validateSetexTtl("3600"), null);
    assert.equal(validateSetexTtl("2592000"), null); // 30 days exactly
  });

  it("rejects TTL of 0", () => {
    assert.notEqual(validateSetexTtl("0"), null);
  });

  it("rejects negative TTL", () => {
    assert.notEqual(validateSetexTtl("-1"), null);
    assert.notEqual(validateSetexTtl("-100"), null);
  });

  it("rejects TTL exceeding 30 days", () => {
    assert.notEqual(validateSetexTtl("2592001"), null);
    assert.notEqual(validateSetexTtl("99999999"), null);
  });

  it("rejects non-integer TTL", () => {
    assert.notEqual(validateSetexTtl("3.5"), null);
    assert.notEqual(validateSetexTtl("abc"), null);
    assert.notEqual(validateSetexTtl(""), null);
  });
});

// ── checkCommand — allowed commands ────────────────────────────────

describe("checkCommand — allowed commands", () => {
  it("allows GET with valid key", () => {
    assert.equal(checkCommand(["GET", "cache:item:42"]), null);
  });

  it("allows GET case-insensitively", () => {
    assert.equal(checkCommand(["get", "mykey"]), null);
    assert.equal(checkCommand(["Get", "mykey"]), null);
  });

  it("allows SETEX with valid key, TTL, and value", () => {
    assert.equal(checkCommand(["SETEX", "cache:item:42", "3600", "somevalue"]), null);
  });

  it("allows PUBLISH with valid channel", () => {
    assert.equal(checkCommand(["PUBLISH", "notifications:build", "payload"]), null);
  });

  it("allows PING without args", () => {
    assert.equal(checkCommand(["PING"]), null);
  });

  it("allows QUIT", () => {
    assert.equal(checkCommand(["QUIT"]), null);
  });
});

// ── checkCommand — disallowed commands ─────────────────────────────

describe("checkCommand — disallowed commands", () => {
  const disallowed = ["DEL", "KEYS", "FLUSHALL", "CONFIG", "EVAL", "SCRIPT",
    "SET", "FLUSHDB", "SUBSCRIBE", "UNSUBSCRIBE", "AUTH", "SELECT",
    "RENAME", "EXPIRE", "PERSIST", "SCAN", "HSET", "HGET", "LPUSH",
    "RPUSH", "SADD", "ZADD", "XADD", "CLIENT", "DEBUG", "SHUTDOWN",
    "SLAVEOF", "REPLICAOF", "MODULE", "CLUSTER"];

  for (const cmd of disallowed) {
    it(`rejects ${cmd}`, () => {
      assert.equal(checkCommand([cmd, "somekey"]), "-ERR command not allowed\r\n");
    });
  }
});

// ── checkCommand — key validation ──────────────────────────────────

describe("checkCommand — key validation", () => {
  it("rejects GET with path traversal key", () => {
    assert.equal(checkCommand(["GET", "foo/../etc/passwd"]), "-ERR invalid key\r\n");
  });

  it("rejects GET with absolute path key", () => {
    assert.equal(checkCommand(["GET", "/etc/shadow"]), "-ERR invalid key\r\n");
  });

  it("rejects GET with shell injection in key", () => {
    assert.equal(checkCommand(["GET", "key; rm -rf /"]), "-ERR invalid key\r\n");
  });

  it("rejects SETEX with invalid key", () => {
    assert.equal(checkCommand(["SETEX", "bad key!", "60", "val"]), "-ERR invalid key\r\n");
  });

  it("rejects PUBLISH with invalid channel name", () => {
    assert.equal(checkCommand(["PUBLISH", "chan nel", "msg"]), "-ERR invalid key\r\n");
  });

  it("rejects GET with missing key", () => {
    assert.equal(checkCommand(["GET"]), "-ERR invalid key\r\n");
  });
});

// ── checkCommand — SETEX TTL validation ────────────────────────────

describe("checkCommand — SETEX TTL validation", () => {
  it("rejects SETEX with negative TTL", () => {
    const result = checkCommand(["SETEX", "mykey", "-1", "val"]);
    assert.ok(result?.includes("-ERR"));
    assert.ok(result?.endsWith("\r\n"));
  });

  it("rejects SETEX with zero TTL", () => {
    const result = checkCommand(["SETEX", "mykey", "0", "val"]);
    assert.ok(result?.includes("-ERR"));
  });

  it("rejects SETEX with TTL exceeding 30 days", () => {
    const result = checkCommand(["SETEX", "mykey", "2592001", "val"]);
    assert.ok(result?.includes("-ERR"));
  });

  it("rejects SETEX with missing arguments", () => {
    const result = checkCommand(["SETEX", "mykey", "60"]);
    assert.ok(result?.includes("-ERR"));
  });

  it("rejects SETEX with non-numeric TTL", () => {
    const result = checkCommand(["SETEX", "mykey", "abc", "val"]);
    assert.ok(result?.includes("-ERR"));
  });
});

// ── Error response format ──────────────────────────────────────────

describe("RESP error response format", () => {
  it("rejected command error starts with - and ends with \\r\\n", () => {
    const err = checkCommand(["FLUSHALL"]);
    assert.notEqual(err, null);
    assert.ok(err!.startsWith("-"));
    assert.ok(err!.endsWith("\r\n"));
  });

  it("invalid key error starts with - and ends with \\r\\n", () => {
    const err = checkCommand(["GET", "bad key!"]);
    assert.notEqual(err, null);
    assert.ok(err!.startsWith("-"));
    assert.ok(err!.endsWith("\r\n"));
  });

  it("SETEX TTL error starts with - and ends with \\r\\n", () => {
    const err = checkCommand(["SETEX", "key", "-5", "val"]);
    assert.notEqual(err, null);
    assert.ok(err!.startsWith("-"));
    assert.ok(err!.endsWith("\r\n"));
  });

  it("all error responses are valid RESP simple errors (single line, no embedded \\r\\n)", () => {
    const errors = [
      checkCommand(["DEL", "x"]),
      checkCommand(["GET", "../etc/passwd"]),
      checkCommand(["SETEX", "k", "0", "v"]),
      checkCommand(["SETEX", "k", "99999999", "v"]),
      checkCommand([]),
    ].filter(Boolean) as string[];

    for (const err of errors) {
      // RESP simple errors: exactly one \r\n at the very end
      const withoutTrailing = err.slice(0, -2);
      assert.ok(!withoutTrailing.includes("\r"), `error contains embedded \\r: ${err}`);
      assert.ok(!withoutTrailing.includes("\n"), `error contains embedded \\n: ${err}`);
    }
  });
});
