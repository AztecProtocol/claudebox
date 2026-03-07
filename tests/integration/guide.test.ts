/**
 * Integration tests for `claudebox guide` command.
 *
 * Uses mock-claude via MOCK_CLAUDE env var to simulate the full flow:
 *   pull session → run claude in container → push session back
 *
 * Tests run without a real server — uses local worktree dirs directly.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";

const CLI = join(import.meta.dirname, "../../cli.ts");
const MOCK_CLAUDE = join(import.meta.dirname, "../mocks/mock-claude.ts");
const NODE_ARGS = ["--experimental-strip-types", "--no-warnings"];

const TEST_DIR = join(tmpdir(), `claudebox-guide-test-${Date.now()}`);
const FAKE_HOME = TEST_DIR;
const CONFIG_DIR = join(FAKE_HOME, ".claudebox");
const WORKTREES_DIR = join(CONFIG_DIR, "worktrees");

/** Build a mock-claude wrapper script path. */
function mockClaudeScript(): string {
  const script = join(TEST_DIR, "mock-claude");
  writeFileSync(script, [
    "#!/bin/bash",
    `exec node --experimental-strip-types --no-warnings ${MOCK_CLAUDE} "$@"`,
  ].join("\n"), { mode: 0o755 });
  return script;
}

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [...NODE_ARGS, CLI, ...args], {
    env: {
      ...process.env,
      HOME: TEST_DIR,
      MOCK_CLAUDE: mockClaudeScript(),
      ...env,
    },
    cwd: TEST_DIR,
    timeout: 30_000,
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? 1,
  };
}

describe("claudebox guide", () => {
  let worktreeId: string;
  let sessionId: string;
  let claudeProjectsDir: string;

  beforeEach(() => {
    worktreeId = randomUUID().replace(/-/g, "").slice(0, 16);
    sessionId = randomUUID();
    claudeProjectsDir = join(WORKTREES_DIR, worktreeId, "claude-projects");
    mkdirSync(claudeProjectsDir, { recursive: true });

    // Create a fake session JSONL (as if a previous Claude run happened)
    const sessionFile = join(claudeProjectsDir, `${sessionId}.jsonl`);
    const events = [
      { type: "init", session_id: sessionId, timestamp: new Date().toISOString(), model: "test" },
      { type: "assistant", text: "I analyzed the codebase and found 3 issues.", timestamp: new Date().toISOString() },
      { type: "tool_use", tool: "Read", input: { file_path: "/workspace/src/main.ts" }, timestamp: new Date().toISOString() },
      { type: "result", session_id: sessionId, exit_code: 0, timestamp: new Date().toISOString() },
    ];
    writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("shows help with --help", () => {
    const r = runCli(["guide", "--help"]);
    assert.match(r.stdout, /Pull a remote session/);
    assert.match(r.stdout, /--no-push/);
  });

  it("errors when no session exists and no server", () => {
    const fakeId = "abcd1234abcd1234";
    const r = runCli(["guide", fakeId, "--no-push"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No local session|no server/i);
  });

  it("runs mock-claude against an existing local session", () => {
    const r = runCli(["guide", worktreeId, "--no-push"], { HOME: FAKE_HOME });

    assert.match(r.stdout, /mock-claude/i, `Expected mock-claude output, got: ${r.stdout}`);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  });

  it("mock-claude creates a new session JSONL when run with guide prompt", () => {
    const r = runCli(["guide", worktreeId, "--no-push"], { HOME: FAKE_HOME });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const jsonlFiles = readdirSync(claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    assert.ok(jsonlFiles.length >= 1, `Expected JSONL files, found: ${jsonlFiles}`);
  });

  it("mock-claude receives resume ID from existing session", () => {
    const r = runCli(["guide", worktreeId, "--no-push"], { HOME: FAKE_HOME });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Resuming:/, `Expected resume output. stdout: ${r.stdout}`);
    assert.match(r.stdout, new RegExp(sessionId.slice(0, 8)), `Expected session ID in output. stdout: ${r.stdout}`);
  });

  it("mock-claude outputs guide questions when given review prompt", () => {
    const r = runCli(["guide", worktreeId, "--no-push"], { HOME: FAKE_HOME });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Session Review/, `Expected guide output. stdout: ${r.stdout}`);
    assert.match(r.stdout, /Questions for Direction/, `Expected questions. stdout: ${r.stdout}`);
  });

  it("passes --model flag to mock-claude", () => {
    const r = runCli([
      "guide", worktreeId,
      "--model", "claude-haiku-4-5-20251001",
      "--no-push",
    ], { HOME: FAKE_HOME });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Model: claude-haiku/, `Expected model in output. stdout: ${r.stdout}`);
  });
});

describe("mock-claude CLI args", () => {
  it("parses -p prompt flag", () => {
    const r = spawnSync("node", [
      ...NODE_ARGS, MOCK_CLAUDE,
      "--print", "-p", "hello world",
    ], {
      env: {
        ...process.env,
        CLAUDEBOX_PROJECTS_DIR: join(TEST_DIR, "projects"),
        CLAUDEBOX_WORKSPACE: join(TEST_DIR, "workspace"),
        MOCK_DELAY_MS: "1",
      },
      timeout: 10_000,
      encoding: "utf-8",
    });

    mkdirSync(join(TEST_DIR, "workspace"), { recursive: true });
    assert.match(r.stdout, /hello world/, `Expected prompt in output. stdout: ${r.stdout}`);
  });

  it("parses --resume flag", () => {
    const resumeId = randomUUID();
    mkdirSync(join(TEST_DIR, "workspace2"), { recursive: true });

    const r = spawnSync("node", [
      ...NODE_ARGS, MOCK_CLAUDE,
      "--print", "-p", "test", "--resume", resumeId,
    ], {
      env: {
        ...process.env,
        CLAUDEBOX_PROJECTS_DIR: join(TEST_DIR, "projects2"),
        CLAUDEBOX_WORKSPACE: join(TEST_DIR, "workspace2"),
        MOCK_DELAY_MS: "1",
      },
      timeout: 10_000,
      encoding: "utf-8",
    });

    assert.match(r.stdout, new RegExp(`Resuming: ${resumeId.slice(0, 8)}`));
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});
