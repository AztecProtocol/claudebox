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

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ── CLI arg parsing (mimics real claude flags) ──────────────────
const args = process.argv.slice(2);
let cliPrompt = "";
let cliResume = "";
let cliModel = "";
let cliPrint = false;
let cliSessionId = "";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-p" && i + 1 < args.length) { cliPrompt = args[++i]; continue; }
  if (a === "--print") { cliPrint = true; continue; }
  if (a === "--resume" && i + 1 < args.length) { cliResume = args[++i]; continue; }
  if (a === "--model" && i + 1 < args.length) { cliModel = args[++i]; continue; }
  if (a === "--session-id" && i + 1 < args.length) { cliSessionId = args[++i]; continue; }
  if (a === "--dangerously-skip-permissions" || a === "--mcp-config" || a === "--fork-session") {
    if (a === "--mcp-config") i++; // skip next arg (config path)
    continue;
  }
}

const WORKSPACE = process.env.CLAUDEBOX_WORKSPACE || "/workspace";
const SESSION_ID = cliSessionId || process.env.SESSION_UUID || randomUUID();
const PROMPT = cliPrompt || process.env.CLAUDEBOX_PROMPT || "test prompt";
const RESUME_ID = cliResume || process.env.CLAUDEBOX_RESUME_ID || "";
const EXIT_CODE = parseInt(process.env.MOCK_EXIT_CODE || "0", 10);
const DELAY_MS = parseInt(process.env.MOCK_DELAY_MS || "100", 10);

// Where Claude writes session JSONL — in the real setup, this is bind-mounted
// from the host's claudeProjectsDir. Use CLAUDEBOX_PROJECTS_DIR for tests.
const projectsDir = process.env.CLAUDEBOX_PROJECTS_DIR
  || join(process.env.HOME || "/home/aztec-dev", ".claude", "projects", "-workspace");
mkdirSync(projectsDir, { recursive: true });

const sessionFile = join(projectsDir, `${SESSION_ID}.jsonl`);
try { mkdirSync(WORKSPACE, { recursive: true }); } catch {}
const activityFile = join(WORKSPACE, "activity.jsonl");

function writeJsonl(file: string, obj: any): void {
  appendFileSync(file, JSON.stringify(obj) + "\n");
}

function writeActivity(type: string, text: string): void {
  try {
    writeJsonl(activityFile, {
      ts: new Date().toISOString(),
      type,
      text,
    });
  } catch {}
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log(`[mock-claude] Session ${SESSION_ID}`);
  console.log(`[mock-claude] Prompt: ${PROMPT.slice(0, 100)}`);
  console.log(`[mock-claude] cwd: ${process.cwd()}`);
  if (RESUME_ID) console.log(`[mock-claude] Resuming: ${RESUME_ID}`);
  if (cliModel) console.log(`[mock-claude] Model: ${cliModel}`);

  // List workspace files so tests can verify repo is mounted
  try {
    const files = readdirSync(process.cwd());
    console.log(`[mock-claude] workspace files: ${files.join(", ")}`);
  } catch {}

  // Write init event
  writeJsonl(sessionFile, {
    type: "init",
    session_id: SESSION_ID,
    timestamp: new Date().toISOString(),
    model: cliModel || "mock-claude-test",
    resume_from: RESUME_ID || undefined,
  });

  writeActivity("status", "Starting mock session...");
  await sleep(DELAY_MS);

  // Detect guide mode — prompt contains "review" and "question"
  const isGuide = PROMPT.toLowerCase().includes("review") && PROMPT.toLowerCase().includes("question");

  if (isGuide) {
    // Guide mode: output session review + questions
    const guideResponse = [
      "## Session Review",
      "",
      "I've reviewed the conversation history. Here's what happened:",
      "- The session started with a code review request",
      "- Several files were analyzed and issues identified",
      "- A PR was drafted but needs direction on scope",
      "",
      "## Questions for Direction",
      "",
      "1. **Scope**: Should we focus on just the critical bugs, or also address code style issues?",
      "2. **Testing**: Should I write unit tests for the fixes, or rely on existing integration tests?",
      "3. **PR Strategy**: Single large PR or multiple small PRs?",
      "",
      "Please provide your answers so the session can continue with clear direction.",
    ].join("\n");

    console.log(guideResponse);

    writeJsonl(sessionFile, {
      type: "assistant",
      text: guideResponse,
      timestamp: new Date().toISOString(),
    });
    writeActivity("response", guideResponse);
  } else {
    // Normal mode: simulate reading files and responding
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

    writeJsonl(sessionFile, {
      type: "assistant",
      text: `I've analyzed the request: "${PROMPT.slice(0, 50)}". Here is my response.`,
      timestamp: new Date().toISOString(),
    });

    await sleep(DELAY_MS);
    writeActivity("response", `Mock response to: ${PROMPT.slice(0, 80)}`);

    const testFile = join(WORKSPACE, "mock-output.txt");
    try { writeFileSync(testFile, `Mock output for session ${SESSION_ID}\n`); } catch {}

    writeJsonl(sessionFile, {
      type: "tool_use",
      tool: "Write",
      input: { file_path: testFile, content: "Mock output" },
      timestamp: new Date().toISOString(),
    });
  }

  writeActivity("status", "Session complete");

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
