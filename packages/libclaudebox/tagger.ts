/**
 * Auto-tagging — uses `claude -p` (no tools, stdin only) to tag workspaces.
 * Tags are cached in worktree meta.json.
 */

import { spawn } from "child_process";
import { CLAUDE_BINARY } from "./config.ts";

/** Run claude -p with prompt on stdin. No shell, no tools, no argument injection. */
function runClaudeNoTools(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(CLAUDE_BINARY, [
      "-p",
      "--model", "haiku",
      "--output-format", "text",
      "--tools", "",
      "--no-session-persistence",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
      env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
    });
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const out = Buffer.concat(chunks).toString().trim();
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${out.slice(0, 200)}`));
      resolve(out);
    });
    proc.stdin.end(prompt);
  });
}

const CLEAN = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);

/**
 * Tag a batch of sessions. Reuses existing tags when appropriate, invents new ones when needed.
 * Returns a map of id → tags array.
 */
export async function tagBatch(
  items: { id: string; prompt: string }[],
  existingTags: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (items.length === 0) return result;

  const tagList = existingTags.length > 0
    ? `Existing tags (prefer reusing these): ${existingTags.join(", ")}\n`
    : "";

  const promptList = items.map((it, i) => `${i + 1}. ${it.prompt.slice(0, 200)}`).join("\n");

  try {
    const text = await runClaudeNoTools(
      `Tag each numbered coding task with 1-3 short lowercase tags for dashboard grouping.\n${tagList}You may also invent new tags. Return ONLY a JSON array of arrays (one inner array per task, same order). Example: [["ci","testing"],["crypto","bug-fix"]]\n\n${promptList}`
    );
    const parsed: string[][] = JSON.parse(text);
    items.forEach((it, i) => {
      const tags = (parsed[i] || [])
        .filter((t: any): t is string => typeof t === "string")
        .map(CLEAN)
        .filter(t => t.length > 0)
        .slice(0, 3);
      if (tags.length > 0) result.set(it.id, tags);
    });
  } catch (e) {
    console.warn(`[TAGGER] Batch tagging failed: ${e}`);
  }
  return result;
}
