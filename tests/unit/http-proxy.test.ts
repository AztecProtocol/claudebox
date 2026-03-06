import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesDomain } from "../../sidecar/http-proxy.ts";

const defaultAllowlist = [
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "*.s3.amazonaws.com",
  "*.s3.us-east-2.amazonaws.com",
  "s3.amazonaws.com",
  "s3.us-east-2.amazonaws.com",
];

describe("matchesDomain", () => {
  it("returns true for an exact match in the allowlist", () => {
    assert.equal(matchesDomain("github.com", defaultAllowlist), true);
  });

  it("returns false for a domain not in the allowlist", () => {
    assert.equal(matchesDomain("evil.com", defaultAllowlist), false);
  });

  it("matches wildcard subdomains", () => {
    assert.equal(
      matchesDomain("my-bucket.s3.amazonaws.com", ["*.s3.amazonaws.com"]),
      true,
    );
  });

  it("wildcard does NOT match the bare domain (requires a subdomain)", () => {
    assert.equal(
      matchesDomain("s3.amazonaws.com", ["*.s3.amazonaws.com"]),
      false,
    );
  });

  it("rejects attacker domains that embed the allowed suffix", () => {
    assert.equal(
      matchesDomain("evil.s3.amazonaws.com.attacker.com", [
        "*.s3.amazonaws.com",
      ]),
      false,
    );
  });

  it("blocks everything when the allowlist is empty", () => {
    assert.equal(matchesDomain("github.com", []), false);
    assert.equal(matchesDomain("anything.example.com", []), false);
  });

  it("performs case-insensitive matching", () => {
    assert.equal(matchesDomain("GitHub.COM", defaultAllowlist), true);
    assert.equal(matchesDomain("API.GITHUB.COM", defaultAllowlist), true);
    assert.equal(
      matchesDomain("My-Bucket.S3.AMAZONAWS.COM", ["*.s3.amazonaws.com"]),
      true,
    );
  });

  it("rejects hostnames with path components", () => {
    assert.equal(matchesDomain("github.com/evil", defaultAllowlist), false);
    assert.equal(matchesDomain("github.com?q=1", defaultAllowlist), false);
  });

  it("rejects hostnames with special characters", () => {
    assert.equal(matchesDomain("github.com:8080", defaultAllowlist), false);
    assert.equal(matchesDomain("git hub.com", defaultAllowlist), false);
    assert.equal(matchesDomain("github.com\r\nHost: evil.com", []), false);
    assert.equal(matchesDomain("", defaultAllowlist), false);
  });

  it("handles multi-level subdomain wildcards", () => {
    assert.equal(
      matchesDomain("a.b.s3.amazonaws.com", ["*.s3.amazonaws.com"]),
      true,
    );
  });

  it("exact entries do not match subdomains", () => {
    assert.equal(matchesDomain("sub.github.com", ["github.com"]), false);
  });
});
