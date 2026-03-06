/**
 * Security tests: credential isolation in the Claude container.
 *
 * These tests spin up real Docker containers using the project Dockerfile,
 * set ALL credentials to the same canary string, then run various
 * discovery attacks from inside the Claude container to verify the
 * canary is never reachable.
 *
 * Requires Docker. Skipped in CI unless CLAUDEBOX_SECURITY_TESTS=1.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CANARY = "CLAUDEBOX_CANARY_SECRET_DO_NOT_LEAK_xK9mQ7vR3pL2";

const SHOULD_RUN = process.env.CLAUDEBOX_SECURITY_TESTS === "1";
const DOCKER_IMAGE = process.env.CLAUDEBOX_TEST_IMAGE || "claudebox-test:security";
const TEST_DIR = join(tmpdir(), `claudebox-security-${Date.now()}`);

// Container names
const NETWORK = `cbsec-net-${Date.now()}`;
const SIDECAR = `cbsec-sidecar-${Date.now()}`;
const CLAUDE_CTR = `cbsec-claude-${Date.now()}`;

function dockerExec(container: string, cmd: string[], opts?: { user?: string }): { stdout: string; stderr: string; exitCode: number } {
  const args = ["exec"];
  if (opts?.user) args.push("--user", opts.user);
  args.push(container, ...cmd);
  const result = spawnSync("docker", args, { encoding: "utf-8", timeout: 30_000 });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

function assertCanaryNotFound(output: string, context: string) {
  assert.ok(
    !output.includes(CANARY),
    `SECURITY VIOLATION: canary found via ${context}!\nOutput snippet: ${output.slice(0, 500)}`,
  );
}

describe("Credential Isolation (security)", { skip: !SHOULD_RUN }, () => {
  before(() => {
    // Verify Docker is available
    try {
      execFileSync("docker", ["version"], { timeout: 5_000 });
    } catch {
      throw new Error("Docker not available — cannot run security tests");
    }

    // Build test image if needed
    const projectRoot = join(import.meta.url.replace("file://", ""), "..", "..", "..");
    try {
      execFileSync("docker", ["image", "inspect", DOCKER_IMAGE], { timeout: 5_000 });
    } catch {
      console.log("[security] Building test image...");
      execSync(`docker build -t ${DOCKER_IMAGE} ${projectRoot}`, { timeout: 120_000 });
    }

    // Set up test workspace
    mkdirSync(join(TEST_DIR, "workspace"), { recursive: true });
    mkdirSync(join(TEST_DIR, "claude-projects"), { recursive: true });
    mkdirSync(join(TEST_DIR, "stats"), { recursive: true });
    mkdirSync(join(TEST_DIR, "ssh"), { recursive: true });
    writeFileSync(join(TEST_DIR, "workspace", "prompt.txt"), "security test prompt");
    writeFileSync(join(TEST_DIR, "ssh", "key"), "mock-ssh-key");

    // Create a minimal MCP sidecar script that holds the secrets
    writeFileSync(join(TEST_DIR, "sidecar.ts"), `
import { createServer } from "http";
const server = createServer((req, res) => {
  if (req.url === "/health") { res.end("ok"); return; }
  if (req.url === "/mcp") { res.writeHead(200); res.end("{}"); return; }
  res.writeHead(404); res.end();
});
server.listen(9801, () => console.log("sidecar ready"));
`);

    // Create network
    execFileSync("docker", ["network", "create", NETWORK], { timeout: 10_000 });

    // Start sidecar with ALL secrets set to canary
    const uid = `${process.getuid!()}:${process.getgid!()}`;
    execFileSync("docker", [
      "run", "-d",
      "--name", SIDECAR,
      "--network", NETWORK,
      "-e", `GH_TOKEN=${CANARY}`,
      "-e", `SLACK_BOT_TOKEN=${CANARY}`,
      "-e", `LINEAR_API_KEY=${CANARY}`,
      "-e", `API_SECRET=${CANARY}`,
      "-e", `CLAUDEBOX_SESSION_PASS=${CANARY}`,
      "-v", `${join(TEST_DIR, "workspace")}:/workspace:rw`,
      "-v", `${join(TEST_DIR, "sidecar.ts")}:/opt/sidecar.ts:ro`,
      "--entrypoint", "node",
      DOCKER_IMAGE,
      "--experimental-strip-types", "--no-warnings", "/opt/sidecar.ts",
    ], { timeout: 30_000 });

    // Wait for sidecar health
    let healthy = false;
    for (let i = 0; i < 20; i++) {
      try {
        const r = dockerExec(SIDECAR, ["curl", "-sf", "http://127.0.0.1:9801/health"]);
        if (r.stdout.includes("ok")) { healthy = true; break; }
      } catch {}
      execSync("sleep 0.5");
    }
    if (!healthy) throw new Error("Sidecar never became healthy");

    // Start Claude container — NO secret env vars, only CI_PASSWORD (also canary to test)
    // But the key point: GH_TOKEN, SLACK_BOT_TOKEN, LINEAR_API_KEY are NOT passed
    execFileSync("docker", [
      "run", "-d",
      "--name", CLAUDE_CTR,
      "--network", NETWORK,
      "-e", `HOME=/home/aztec-dev`,
      "-e", `CI_PASSWORD=${CANARY}`,  // this one IS expected in Claude container
      "-e", `CLAUDEBOX_MCP_URL=http://${SIDECAR}:9801/mcp`,
      "-e", `CLAUDEBOX_SIDECAR_HOST=${SIDECAR}`,
      "-e", `CLAUDEBOX_SIDECAR_PORT=9801`,
      "-v", `${join(TEST_DIR, "workspace")}:/workspace:rw`,
      "--entrypoint", "sleep",
      DOCKER_IMAGE,
      "300",  // keep alive for tests
    ], { timeout: 30_000 });

    // Wait for container to be running
    for (let i = 0; i < 10; i++) {
      const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CLAUDE_CTR], { encoding: "utf-8" });
      if (r.stdout?.trim() === "true") break;
      execSync("sleep 0.5");
    }
  });

  after(() => {
    // Cleanup containers and network
    try { execFileSync("docker", ["rm", "-f", CLAUDE_CTR], { timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["rm", "-f", SIDECAR], { timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["network", "rm", NETWORK], { timeout: 10_000 }); } catch {}
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  // ── ENV VAR TESTS ──

  it("canary NOT in Claude container env vars (except CI_PASSWORD)", () => {
    const r = dockerExec(CLAUDE_CTR, ["env"]);
    // Remove CI_PASSWORD line (that one IS expected)
    const envWithoutCiPass = r.stdout
      .split("\n")
      .filter(l => !l.startsWith("CI_PASSWORD="))
      .join("\n");

    assertCanaryNotFound(envWithoutCiPass, "env vars (excluding CI_PASSWORD)");
  });

  it("GH_TOKEN not set in Claude container", () => {
    const r = dockerExec(CLAUDE_CTR, ["bash", "-c", "echo GH=$GH_TOKEN"]);
    assert.equal(r.stdout.trim(), "GH=", "GH_TOKEN should be empty in Claude container");
  });

  it("SLACK_BOT_TOKEN not set in Claude container", () => {
    const r = dockerExec(CLAUDE_CTR, ["bash", "-c", "echo SB=$SLACK_BOT_TOKEN"]);
    assert.equal(r.stdout.trim(), "SB=", "SLACK_BOT_TOKEN should be empty in Claude container");
  });

  it("LINEAR_API_KEY not set in Claude container", () => {
    const r = dockerExec(CLAUDE_CTR, ["bash", "-c", "echo LK=$LINEAR_API_KEY"]);
    assert.equal(r.stdout.trim(), "LK=", "LINEAR_API_KEY should be empty in Claude container");
  });

  it("API_SECRET not set in Claude container", () => {
    const r = dockerExec(CLAUDE_CTR, ["bash", "-c", "echo AS=$API_SECRET"]);
    assert.equal(r.stdout.trim(), "AS=", "API_SECRET should be empty in Claude container");
  });

  it("CLAUDEBOX_SESSION_PASS not set in Claude container", () => {
    const r = dockerExec(CLAUDE_CTR, ["bash", "-c", "echo SP=$CLAUDEBOX_SESSION_PASS"]);
    assert.equal(r.stdout.trim(), "SP=", "CLAUDEBOX_SESSION_PASS should be empty in Claude container");
  });

  // ── /proc ENVIRONMENT SNOOPING ──

  it("canary NOT in /proc/1/environ", () => {
    const r = dockerExec(CLAUDE_CTR, ["cat", "/proc/1/environ"]);
    // Remove CI_PASSWORD entries (expected to be there)
    const cleaned = r.stdout.replace(/CI_PASSWORD=[^\0]*/g, "");
    assertCanaryNotFound(cleaned, "/proc/1/environ");
  });

  it("canary NOT in /proc/*/environ (all processes)", () => {
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c",
      "for f in /proc/[0-9]*/environ; do cat $f 2>/dev/null; echo; done",
    ]);
    // Remove CI_PASSWORD entries
    const cleaned = r.stdout.replace(/CI_PASSWORD=[^\0]*/g, "");
    assertCanaryNotFound(cleaned, "/proc/*/environ");
  });

  // ── /proc MEMORY SNOOPING ──

  it("cannot read /proc/1/mem (permission denied)", () => {
    const r = dockerExec(CLAUDE_CTR, ["bash", "-c", "cat /proc/1/mem 2>&1 || true"]);
    // Should fail — either permission denied or input/output error
    assert.ok(
      r.exitCode !== 0 || r.stderr.includes("ermission") || r.stdout.includes("ermission") ||
      r.stderr.includes("Input/output error") || r.stdout.includes("Input/output error"),
      "Reading /proc/1/mem should fail",
    );
  });

  // ── FILESYSTEM SEARCH ──

  it("canary NOT in mounted source files (/opt/claudebox)", () => {
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c",
      `grep -r "${CANARY}" /opt/claudebox/ 2>/dev/null || true`,
    ]);
    assertCanaryNotFound(r.stdout, "/opt/claudebox file search");
  });

  it("canary NOT in workspace files", () => {
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c",
      `grep -r "${CANARY}" /workspace/ 2>/dev/null || true`,
    ]);
    assertCanaryNotFound(r.stdout, "/workspace file search");
  });

  it("canary NOT findable via broad filesystem grep", () => {
    // Search common locations where secrets might leak
    const dirs = ["/tmp", "/home", "/etc", "/var"];
    for (const dir of dirs) {
      const r = dockerExec(CLAUDE_CTR, [
        "bash", "-c",
        `grep -r "${CANARY}" ${dir}/ 2>/dev/null || true`,
      ]);
      // CI_PASSWORD may appear in /home/aztec-dev/.bashrc or similar — filter it out
      const cleaned = r.stdout
        .split("\n")
        .filter(l => !l.includes("CI_PASSWORD"))
        .join("\n");
      assertCanaryNotFound(cleaned, `filesystem grep of ${dir}`);
    }
  });

  // ── NETWORK SNOOPING ──

  it("cannot reach sidecar secrets via HTTP endpoints", () => {
    // Try various paths that might expose env vars
    const paths = ["/env", "/debug", "/vars", "/_env", "/config", "/secrets", "/proc"];
    for (const path of paths) {
      const r = dockerExec(CLAUDE_CTR, [
        "curl", "-sf", `http://${SIDECAR}:9801${path}`,
      ]);
      assertCanaryNotFound(r.stdout, `sidecar HTTP ${path}`);
    }
  });

  it("sidecar /health does not leak credentials", () => {
    const r = dockerExec(CLAUDE_CTR, ["curl", "-sf", `http://${SIDECAR}:9801/health`]);
    assertCanaryNotFound(r.stdout, "sidecar /health");
  });

  it("cannot inspect sidecar container from Claude container", () => {
    // Docker socket should not be mounted in Claude container
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c",
      "docker inspect " + SIDECAR + " 2>&1 || true",
    ]);
    // Either docker command not found, or socket not available
    assert.ok(
      r.exitCode !== 0 || r.stdout.includes("not found") || r.stderr.includes("not found") ||
      r.stdout.includes("Cannot connect") || r.stderr.includes("Cannot connect") ||
      r.stdout.includes("permission denied") || r.stderr.includes("permission denied"),
      "Docker inspect of sidecar should fail from Claude container",
    );
    assertCanaryNotFound(r.stdout, "docker inspect sidecar");
  });

  // ── PRIVILEGE ESCALATION ──

  it("cannot run commands as root", () => {
    const r = dockerExec(CLAUDE_CTR, ["whoami"]);
    assert.notEqual(r.stdout.trim(), "root", "Should not be running as root");
  });

  it("cannot sudo", () => {
    const r = dockerExec(CLAUDE_CTR, ["bash", "-c", "sudo id 2>&1 || true"]);
    assert.ok(
      r.exitCode !== 0 || r.stdout.includes("not found") || r.stderr.includes("not found") ||
      r.stdout.includes("not allowed") || r.stderr.includes("not allowed"),
      "sudo should not work",
    );
  });

  it("cannot nsenter into other namespaces", () => {
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c", "nsenter -t 1 -m -u -i -n -p -- env 2>&1 || true",
    ]);
    assert.ok(r.exitCode !== 0, "nsenter should fail");
    assertCanaryNotFound(r.stdout, "nsenter");
  });

  // ── DOCKER-EXEC-AS-ROOT ESCALATION ──
  // This tests that even if someone does `docker exec --user root`,
  // the sidecar env vars are still not accessible from the Claude container

  it("canary NOT visible even when exec'd as root", () => {
    const r = dockerExec(CLAUDE_CTR, ["env"], { user: "root" });
    const cleaned = r.stdout
      .split("\n")
      .filter(l => !l.startsWith("CI_PASSWORD="))
      .join("\n");
    assertCanaryNotFound(cleaned, "root env in Claude container");
  });

  it("cannot see sidecar process env even as root", () => {
    // Sidecar runs in a different container — its /proc is not accessible
    // from Claude container even as root (separate PID namespace)
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c",
      "for f in /proc/[0-9]*/environ; do cat $f 2>/dev/null; echo; done",
    ], { user: "root" });
    const cleaned = r.stdout.replace(/CI_PASSWORD=[^\0]*/g, "");
    // GH_TOKEN, SLACK_BOT_TOKEN, etc should NOT appear since they're in a different container
    assertCanaryNotFound(cleaned, "/proc/*/environ as root (checking cross-container leak)");
  });

  // ── DOCKER SOCKET ──

  it("docker socket not mounted in Claude container", () => {
    const r = dockerExec(CLAUDE_CTR, [
      "bash", "-c",
      "ls -la /var/run/docker.sock 2>&1 || echo 'not found'",
    ]);
    assert.ok(
      r.stdout.includes("not found") || r.stdout.includes("No such file") ||
      r.stderr.includes("No such file"),
      "Docker socket should not be mounted",
    );
  });
});
