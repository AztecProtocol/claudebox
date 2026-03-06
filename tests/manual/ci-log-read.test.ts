/**
 * Manual test: verify Claude container can read CI logs via `ci.sh dlog`.
 *
 * This test is NOT added to CI — it requires:
 * - The bastion SSH key at ~/.ssh/build_instance_key
 * - The aztec-packages repo
 * - Docker
 *
 * Run manually:
 *   CLAUDEBOX_SECURITY_TESTS=1 node --experimental-strip-types --no-warnings \
 *     --test tests/manual/ci-log-read.test.ts
 *
 * Optionally set TEST_LOG_KEY to a known Redis key (default: auto-detected).
 *
 * The Claude container gets the bastion SSH key (for Redis tunnel) but
 * NO API tokens (GH_TOKEN, SLACK_BOT_TOKEN, etc). ci.sh uses the SSH key
 * to open a tunnel to Redis and read logs directly.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

const SHOULD_RUN = process.env.CLAUDEBOX_SECURITY_TESTS === "1";
const DOCKER_IMAGE = process.env.CLAUDEBOX_TEST_IMAGE || "claudebox:latest";
const TEST_DIR = join(tmpdir(), `claudebox-cilog-${Date.now()}`);

const CLAUDE_CTR = `cbcilog-claude-${Date.now()}`;

const BASTION_SSH_KEY = process.env.BASTION_SSH_KEY || join(homedir(), ".ssh", "build_instance_key");
const REPO_DIR = process.env.CLAUDE_REPO_DIR || join(homedir(), "aztec-packages");

// Find a valid log key from Redis (or use TEST_LOG_KEY)
function findValidLogKey(): string {
  if (process.env.TEST_LOG_KEY) return process.env.TEST_LOG_KEY;
  try {
    const result = spawnSync("bash", ["-c", `
      cd ${REPO_DIR} && source ci3/source && source ci3/source_redis &&
      redis_cli --scan 2>/dev/null | head -1
    `], { encoding: "utf-8", timeout: 15_000 });
    const key = result.stdout?.trim();
    if (key && /^[a-f0-9]+$/.test(key)) return key;
  } catch {}
  return "";
}

function dockerExec(container: string, cmd: string[], timeout = 60_000): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("docker", ["exec", container, ...cmd], {
    encoding: "utf-8",
    timeout,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("CI log reading via ci.sh dlog (manual)", { skip: !SHOULD_RUN }, () => {
  let logKey = "";

  before(() => {
    try {
      execFileSync("docker", ["version"], { timeout: 5_000 });
    } catch {
      throw new Error("Docker not available");
    }

    logKey = findValidLogKey();
    if (!logKey) throw new Error("No valid Redis log key found. Set TEST_LOG_KEY or ensure Redis is reachable from host.");
    console.log(`[setup] Using log key: ${logKey}`);

    mkdirSync(join(TEST_DIR, "workspace"), { recursive: true });
    writeFileSync(join(TEST_DIR, "workspace", "prompt.txt"), "test");

    const uid = `${process.getuid!()}:${process.getgid!()}`;

    // Start Claude container with SSH key (for Redis tunnel) but NO API tokens.
    // This mirrors the real container setup in docker.ts.
    execFileSync("docker", [
      "run", "-d",
      "--name", CLAUDE_CTR,
      "--user", uid,
      "-e", `HOME=/home/aztec-dev`,
      "-v", `${join(TEST_DIR, "workspace")}:/workspace:rw`,
      "-v", `${join(REPO_DIR, ".git")}:/reference-repo/.git:ro`,
      "-v", `${BASTION_SSH_KEY}:/home/aztec-dev/.ssh/build_instance_key:ro`,
      "--entrypoint", "sleep",
      DOCKER_IMAGE,
      "300",
    ], { timeout: 30_000 });

    // Wait for container
    for (let i = 0; i < 10; i++) {
      const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CLAUDE_CTR], { encoding: "utf-8" });
      if (r.stdout?.trim() === "true") break;
      execSync("sleep 0.5");
    }

    // Clone the repo inside the container so ci.sh is available
    console.log("[setup] Cloning repo...");
    const cloneResult = dockerExec(CLAUDE_CTR, [
      "git", "clone", "--reference", "/reference-repo", "--dissociate",
      "--depth", "1", "https://github.com/AztecProtocol/aztec-packages.git",
      "/workspace/aztec-packages",
    ], 120_000);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Clone failed: ${cloneResult.stderr.slice(0, 300)}`);
    }
    console.log("[setup] Clone done");
  });

  after(() => {
    try { execFileSync("docker", ["rm", "-f", CLAUDE_CTR], { timeout: 10_000 }); } catch {}
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  it("reads CI log via ci.sh dlog", () => {
    console.log(`[test] Running: ci.sh dlog ${logKey}`);
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c",
      `cd /workspace/aztec-packages && ./ci.sh dlog ${logKey}`,
    ], 60_000);

    console.log(`[ci.sh dlog] exit=${r.exitCode} stdout=${r.stdout.length} bytes`);
    if (r.stderr) console.log(`[ci.sh dlog] stderr: ${r.stderr.slice(0, 500)}`);
    if (r.stdout) console.log(`[ci.sh dlog] first 200 chars: ${r.stdout.slice(0, 200)}`);

    assert.equal(r.exitCode, 0, `ci.sh dlog should succeed. stderr: ${r.stderr.slice(0, 300)}`);
    assert.ok(r.stdout.length > 100, "Log output should have meaningful content");
    assert.ok(
      !r.stdout.includes("Key not found"),
      `Log key ${logKey} should exist in Redis`,
    );
  });

  it("API tokens are NOT in Claude container env", () => {
    const r = dockerExec(CLAUDE_CTR, ["env"]);
    assert.ok(!r.stdout.includes("GH_TOKEN="), "GH_TOKEN should not be in env");
    assert.ok(!r.stdout.includes("SLACK_BOT_TOKEN="), "SLACK_BOT_TOKEN should not be in env");
    assert.ok(!r.stdout.includes("LINEAR_API_KEY="), "LINEAR_API_KEY should not be in env");
    assert.ok(!r.stdout.includes("CI_PASSWORD="), "CI_PASSWORD should not be in env");
  });
});
