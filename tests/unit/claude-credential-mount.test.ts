/**
 * Tests that claude -p works with mounted credentials (the actual auth model).
 *
 * In production, containers get ~/.claude mounted :rw which includes
 * .credentials.json with the OAuth token. This test verifies that the
 * Claude CLI can authenticate and respond using those mounted credentials.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

describe("Claude credential mount", () => {
  it("credentials file exists with OAuth token", () => {
    assert.ok(existsSync(CREDENTIALS_PATH), ".credentials.json should exist");
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
    assert.ok(creds.claudeAiOauth?.accessToken, "should have an OAuth access token");
    assert.ok(creds.claudeAiOauth?.expiresAt > Date.now(), "token should not be expired");
  });

  it("claude -p responds via mounted OAuth credential", () => {
    // Unset CLAUDECODE to allow nested invocation (we're inside Claude Code)
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== "CLAUDECODE" && v !== undefined) env[k] = v;
    }

    const output = execFileSync("claude", ["-p", "Reply with ONLY the word pong"], {
      timeout: 60_000,
      env,
      encoding: "utf-8",
    }).trim();

    console.log(`  → claude -p replied: "${output}"`);
    assert.ok(output.toLowerCase().includes("pong"),
      `expected 'pong' in response, got: "${output}"`);
  });
});
