/**
 * Credential isolation: secrets on the sidecar must not be reachable
 * from the Claude container.
 *
 * Uses ubuntu:latest (no devbox build required). Two containers on a
 * shared Docker network mirror the real topology: sidecar holds all
 * secrets, Claude container gets zero.
 *
 * Requires Docker. Skipped unless CLAUDEBOX_SECURITY_TESTS=1.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "child_process";

const SHOULD_RUN = process.env.CLAUDEBOX_SECURITY_TESTS === "1";
const CANARY = "CLAUDEBOX_CANARY_SECRET_DO_NOT_LEAK_xK9mQ7vR3pL2";
const IMAGE = "ubuntu:latest";
const TAG = `cbsec-${Date.now()}`;
const NETWORK = `${TAG}-net`;
const SIDECAR = `${TAG}-sidecar`;
const CLAUDE_CTR = `${TAG}-claude`;

const SECRETS = [
  "GH_TOKEN", "SLACK_BOT_TOKEN", "LINEAR_API_KEY",
  "CI_PASSWORD", "API_SECRET", "CLAUDEBOX_SESSION_PASS", "ANTHROPIC_API_KEY",
];

function dockerExec(
  container: string, cmd: string[], opts?: { user?: string },
): { stdout: string; stderr: string; exitCode: number } {
  const args = ["exec"];
  if (opts?.user) args.push("--user", opts.user);
  args.push(container, ...cmd);
  const r = spawnSync("docker", args, { encoding: "utf-8", timeout: 30_000 });
  return { stdout: r.stdout || "", stderr: r.stderr || "", exitCode: r.status ?? 1 };
}

function assertCanaryNotFound(output: string, context: string) {
  assert.ok(
    !output.includes(CANARY),
    `SECURITY VIOLATION: canary found via ${context}!\nOutput snippet: ${output.slice(0, 500)}`,
  );
}

describe("Credential Isolation (security)", { skip: !SHOULD_RUN }, () => {
  before(() => {
    execFileSync("docker", ["version"], { timeout: 5_000 });

    execFileSync("docker", ["network", "create", NETWORK], { timeout: 10_000 });

    // Sidecar — gets ALL secrets
    const sidecarEnv = SECRETS.flatMap(k => ["-e", `${k}=${CANARY}`]);
    execFileSync("docker", [
      "run", "-d", "--name", SIDECAR, "--network", NETWORK,
      ...sidecarEnv, IMAGE, "sleep", "120",
    ], { timeout: 30_000 });

    // Claude container — gets ZERO secrets
    execFileSync("docker", [
      "run", "-d", "--name", CLAUDE_CTR, "--network", NETWORK,
      "--user", "nobody",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "-e", "HOME=/tmp",
      "-e", `CLAUDEBOX_SIDECAR_HOST=${SIDECAR}`,
      "-e", "CLAUDEBOX_SIDECAR_PORT=9801",
      IMAGE, "sleep", "120",
    ], { timeout: 30_000 });
  });

  after(() => {
    for (const c of [CLAUDE_CTR, SIDECAR]) {
      try { execFileSync("docker", ["rm", "-f", c], { timeout: 10_000 }); } catch {}
    }
    try { execFileSync("docker", ["network", "rm", NETWORK], { timeout: 10_000 }); } catch {}
  });

  // ── ENV VARS ──

  it("canary NOT in any Claude container env var", () => {
    const r = dockerExec(CLAUDE_CTR, ["env"]);
    assertCanaryNotFound(r.stdout, "env vars");
  });

  for (const key of SECRETS) {
    it(`${key} not set in Claude container`, () => {
      const r = dockerExec(CLAUDE_CTR, ["sh", "-c", `echo V=\$${key}`]);
      assert.equal(r.stdout.trim(), "V=", `${key} should be empty`);
    });
  }

  it("secrets ARE present in sidecar (control)", () => {
    const env = dockerExec(SIDECAR, ["env"]).stdout;
    for (const k of SECRETS) {
      assert.ok(env.includes(`${k}=${CANARY}`), `sidecar missing ${k}`);
    }
  });

  // ── /proc SNOOPING ──

  it("canary NOT in /proc/1/environ", () => {
    const r = dockerExec(CLAUDE_CTR, ["sh", "-c", "cat /proc/1/environ 2>/dev/null || true"]);
    assertCanaryNotFound(r.stdout, "/proc/1/environ");
  });

  it("canary NOT in /proc/*/environ (all processes)", () => {
    const r = dockerExec(CLAUDE_CTR, [
      "sh", "-c",
      "for f in /proc/[0-9]*/environ; do cat $f 2>/dev/null; echo; done",
    ]);
    assertCanaryNotFound(r.stdout, "/proc/*/environ");
  });

  it("canary NOT in /proc/*/environ as root", () => {
    const r = dockerExec(CLAUDE_CTR, [
      "sh", "-c",
      "for f in /proc/[0-9]*/environ; do cat $f 2>/dev/null; echo; done",
    ], { user: "root" });
    assertCanaryNotFound(r.stdout, "/proc/*/environ as root");
  });

  // ── FILESYSTEM ──

  it("canary NOT findable on filesystem", () => {
    const dirs = ["/tmp", "/home", "/etc", "/var", "/workspace", "/opt"];
    for (const dir of dirs) {
      const r = dockerExec(CLAUDE_CTR, [
        "sh", "-c", `grep -r "${CANARY}" ${dir}/ 2>/dev/null || true`,
      ]);
      assertCanaryNotFound(r.stdout, `filesystem grep ${dir}`);
    }
  });

  // ── PRIVILEGE ESCALATION ──

  it("not running as root", () => {
    const r = dockerExec(CLAUDE_CTR, ["id", "-u"]);
    assert.notEqual(r.stdout.trim(), "0", "should not be uid 0");
  });

  it("canary NOT visible even when exec'd as root", () => {
    const r = dockerExec(CLAUDE_CTR, ["env"], { user: "root" });
    assertCanaryNotFound(r.stdout, "root env");
  });

  it("docker socket not mounted", () => {
    const r = dockerExec(CLAUDE_CTR, [
      "sh", "-c", "ls /var/run/docker.sock 2>&1 || echo absent",
    ]);
    assert.ok(
      r.stdout.includes("No such file") || r.stdout.includes("absent"),
      "docker socket should not exist",
    );
  });
});
