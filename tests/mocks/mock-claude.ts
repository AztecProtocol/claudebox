#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Mock Claude binary — simulates Claude's behavior for integration tests.
 *
 * Reads prompt from stdin or CLAUDEBOX_PROMPT env var, writes session JSONL
 * to the expected Claude projects directory, and emits activity events.
 *
 * Usage:
 *   CLAUDEBOX_PROMPT="fix the bug" mock-claude.ts
 *
 * Writes:
 *   - ~/.claude/projects/-workspace/<session-id>.jsonl  (Claude session file)
 *   - /workspace/activity.jsonl  (activity log for status page)
 *
 * The session JSONL format mimics Claude's real output format with
 * init, tool_use, assistant, and result messages.
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const WORKSPACE = process.env.CLAUDEBOX_WORKSPACE || "/workspace";
const SESSION_ID = process.env.SESSION_UUID || randomUUID();
const PROMPT = process.env.CLAUDEBOX_PROMPT || "test prompt";
const RESUME_ID = process.env.CLAUDEBOX_RESUME_ID || "";
const EXIT_CODE = parseInt(process.env.MOCK_EXIT_CODE || "0", 10);
const DELAY_MS = parseInt(process.env.MOCK_DELAY_MS || "100", 10);

// Where Claude writes session JSONL — in the real setup, this is bind-mounted
// from the host's claudeProjectsDir. Use CLAUDEBOX_PROJECTS_DIR for tests.
const projectsDir = process.env.CLAUDEBOX_PROJECTS_DIR
  || join(process.env.HOME || "/home/claude", ".claude", "projects", "-workspace");
mkdirSync(projectsDir, { recursive: true });

const sessionFile = join(projectsDir, `${SESSION_ID}.jsonl`);
const activityFile = join(WORKSPACE, "activity.jsonl");

function writeJsonl(file: string, obj: any): void {
  appendFileSync(file, JSON.stringify(obj) + "\n");
}

function writeActivity(type: string, text: string): void {
  writeJsonl(activityFile, {
    ts: new Date().toISOString(),
    type,
    text,
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log(`[mock-claude] Session ${SESSION_ID}`);
  console.log(`[mock-claude] Prompt: ${PROMPT.slice(0, 100)}`);
  if (RESUME_ID) console.log(`[mock-claude] Resuming: ${RESUME_ID}`);

  // Write init event
  writeJsonl(sessionFile, {
    type: "init",
    session_id: SESSION_ID,
    timestamp: new Date().toISOString(),
    model: "mock-claude-test",
    resume_from: RESUME_ID || undefined,
  });

  writeActivity("status", "Starting mock session...");
  await sleep(DELAY_MS);

  // Simulate reading files
  writeJsonl(sessionFile, {
    type: "tool_use",
    tool: "Read",
    input: { file_path: "/workspace/prompt.txt" },
    timestamp: new Date().toISOString(),
  });

  writeJsonl(sessionFile, {
    type: "tool_result",
    tool: "Read",
    output: PROMPT,
    timestamp: new Date().toISOString(),
  });

  await sleep(DELAY_MS);
  writeActivity("status", "Processing...");

  // Simulate assistant response
  writeJsonl(sessionFile, {
    type: "assistant",
    text: `I've analyzed the request: "${PROMPT.slice(0, 50)}". Here is my response.`,
    timestamp: new Date().toISOString(),
  });

  await sleep(DELAY_MS);
  writeActivity("response", `Mock response to: ${PROMPT.slice(0, 80)}`);

  // Simulate creating a file
  const testFile = join(WORKSPACE, "mock-output.txt");
  writeFileSync(testFile, `Mock output for session ${SESSION_ID}\n`);

  writeJsonl(sessionFile, {
    type: "tool_use",
    tool: "Write",
    input: { file_path: testFile, content: "Mock output" },
    timestamp: new Date().toISOString(),
  });

  writeActivity("status", "Session complete");

  // Write completion event
  writeJsonl(sessionFile, {
    type: "result",
    session_id: SESSION_ID,
    exit_code: EXIT_CODE,
    timestamp: new Date().toISOString(),
  });

  console.log(`[mock-claude] Done (exit ${EXIT_CODE})`);
  process.exit(EXIT_CODE);
}

main().catch(e => {
  console.error(`[mock-claude] Fatal: ${e.message}`);
  process.exit(1);
});
