/**
 * Manual test: verify Claude container can read CI logs via `ci.sh dlog`.
 *
 * This test is NOT added to CI — it requires:
 * - A running sidecar with Redis tunnel access (bastion SSH)
 * - The aztec-packages repo with ci.sh
 *
 * Run manually:
 *   CLAUDEBOX_SECURITY_TESTS=1 node --experimental-strip-types --no-warnings \
 *     --test tests/manual/ci-log-read.test.ts
 *
 * It starts a sidecar (with real credentials) and a Claude container,
 * then runs `ci.sh dlog <key>` inside the Claude container and verifies
 * that log output is returned without directly exposing credentials.
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
const LOG_KEY = process.env.TEST_LOG_KEY || "d720d97bbb5cbe32";

const NETWORK = `cbcilog-net-${Date.now()}`;
const SIDECAR = `cbcilog-sidecar-${Date.now()}`;
const CLAUDE_CTR = `cbcilog-claude-${Date.now()}`;

// Real credentials from the host environment
const GH_TOKEN = process.env.GH_TOKEN || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const BASTION_SSH_KEY = process.env.BASTION_SSH_KEY || join(homedir(), ".ssh", "build_instance_key");
const REPO_DIR = process.env.CLAUDE_REPO_DIR || join(homedir(), "aztec-packages");
const CLAUDEBOX_CODE_DIR = process.env.CLAUDEBOX_CODE_DIR || join(REPO_DIR, ".claude", "claudebox");

function dockerExec(container: string, cmd: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("docker", ["exec", container, ...cmd], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("CI log reading via ci.sh dlog (manual)", { skip: !SHOULD_RUN }, () => {
  before(() => {
    try {
      execFileSync("docker", ["version"], { timeout: 5_000 });
    } catch {
      throw new Error("Docker not available");
    }

    mkdirSync(join(TEST_DIR, "workspace"), { recursive: true });
    writeFileSync(join(TEST_DIR, "workspace", "prompt.txt"), "test");

    // Create network
    execFileSync("docker", ["network", "create", NETWORK], { timeout: 10_000 });

    const uid = `${process.getuid!()}:${process.getgid!()}`;

    // Start sidecar with real credentials + cred-proxy
    execFileSync("docker", [
      "run", "-d",
      "--name", SIDECAR,
      "--network", NETWORK,
      "--user", uid,
      "-e", `HOME=/home/aztec-dev`,
      "-e", `GH_TOKEN=${GH_TOKEN}`,
      "-e", `SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}`,
      "-e", `MCP_PORT=9801`,
      "-v", `${join(TEST_DIR, "workspace")}:/workspace:rw`,
      "-v", `${CLAUDEBOX_CODE_DIR}:/opt/claudebox:ro`,
      "-v", `${BASTION_SSH_KEY}:/home/aztec-dev/.ssh/build_instance_key:ro`,
      "--entrypoint", "/opt/claudebox/profiles/default/mcp-sidecar.ts",
      DOCKER_IMAGE,
    ], { timeout: 30_000 });

    // Wait for sidecar health
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = dockerExec(SIDECAR, ["curl", "-sf", "http://127.0.0.1:9801/health"]);
        if (r.stdout.includes("ok")) { healthy = true; break; }
      } catch {}
      execSync("sleep 1");
    }
    if (!healthy) throw new Error("Sidecar never became healthy");

    // Start Claude container — no credentials, just AZTEC_MCP_SERVER pointing to sidecar
    execFileSync("docker", [
      "run", "-d",
      "--name", CLAUDE_CTR,
      "--network", NETWORK,
      "--user", uid,
      "-e", `HOME=/home/aztec-dev`,
      "-e", `AZTEC_MCP_SERVER=http://${SIDECAR}:9801/creds`,
      "-e", `CLAUDEBOX_MCP_URL=http://${SIDECAR}:9801/mcp`,
      "-v", `${join(TEST_DIR, "workspace")}:/workspace:rw`,
      "-v", `${join(REPO_DIR, ".git")}:/reference-repo/.git:ro`,
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
    dockerExec(CLAUDE_CTR, [
      "git", "clone", "--reference", "/reference-repo", "--dissociate",
      "--depth", "1", "https://github.com/AztecProtocol/aztec-packages.git",
      "/workspace/aztec-packages",
    ]);
  });

  after(() => {
    try { execFileSync("docker", ["rm", "-f", CLAUDE_CTR], { timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["rm", "-f", SIDECAR], { timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["network", "rm", NETWORK], { timeout: 10_000 }); } catch {}
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  it(`reads CI log ${LOG_KEY} via ci.sh dlog`, () => {
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c",
      `cd /workspace/aztec-packages && ./ci.sh dlog ${LOG_KEY}`,
    ]);

    console.log(`[ci.sh dlog] exit=${r.exitCode} stdout=${r.stdout.length} bytes`);
    if (r.stderr) console.log(`[ci.sh dlog] stderr: ${r.stderr.slice(0, 500)}`);

    assert.equal(r.exitCode, 0, `ci.sh dlog should succeed. stderr: ${r.stderr.slice(0, 300)}`);
    assert.ok(r.stdout.length > 0, "Log output should not be empty");
  });

  it("credentials are NOT in Claude container env", () => {
    const r = dockerExec(CLAUDE_CTR, ["env"]);
    assert.ok(!r.stdout.includes("GH_TOKEN="), "GH_TOKEN should not be in env");
    assert.ok(!r.stdout.includes("SLACK_BOT_TOKEN="), "SLACK_BOT_TOKEN should not be in env");
    // AZTEC_MCP_SERVER is expected — it's the proxy URL, not a secret
    assert.ok(r.stdout.includes("AZTEC_MCP_SERVER="), "AZTEC_MCP_SERVER should be set");
  });
});
