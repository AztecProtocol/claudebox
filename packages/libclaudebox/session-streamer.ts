/**
 * session-streamer.ts — Unified Claude JSONL processor
 *
 * Runs on the HOST, started by docker.ts when a session launches.
 * Reads Claude's session JSONL in real-time and:
 *   1. Writes rich activity events to activity.jsonl (for SSE → status page)
 *   2. Produces pretty-printed text piped to cache_log (for CI log links)
 *   3. Discovers subagent JSONL files and creates sub-log links
 *
 * Replaces both the sidecar transcript poller AND the old stream-session.ts.
 */

import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, fstatSync, closeSync, appendFileSync, watch } from "fs";
import { join, basename } from "path";
import { spawnSync, spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";

// ── Types ───────────────────────────────────────────────────────

export interface StreamerOpts {
  /** Claude projects dir (where .jsonl files live) */
  projectDir: string;
  /** Path to activity.jsonl to write events to */
  activityLog: string;
  /** Repo dir (for cache_log binary, denoise script) */
  repoDir: string;
  /** Parent log ID (for cache_log sub-logs) */
  parentLogId: string;
  /** Callback for pretty-printed lines (piped to cache_log stdin) */
  onOutput?: (text: string) => void;
}

interface ActivityEvent {
  ts: string;
  type: string;
  text: string;
  log_id?: string;
  subagent?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────

function trunc(s: string, n = 200): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

const SPILL_THRESHOLD = 1500;

/** Find newest JSONL file in dir (recursive). */
function findNewestJsonl(dir: string): string | null {
  try {
    const results: { path: string; mtime: number }[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".jsonl"))
          results.push({ path: full, mtime: statSync(full).mtimeMs });
      }
    };
    walk(dir);
    results.sort((a, b) => b.mtime - a.mtime);
    return results[0]?.path ?? null;
  } catch { return null; }
}

/** Find all JSONL files in dir (recursive). */
function findAllJsonl(dir: string): string[] {
  const results: string[] = [];
  try {
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".jsonl")) results.push(full);
      }
    };
    walk(dir);
  } catch {}
  return results;
}

// ── SessionStreamer ──────────────────────────────────────────────

export class SessionStreamer {
  private opts: StreamerOpts;
  private tailers = new Map<string, JsonlTailer>();
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cacheLogBin: string;
  private denoiseScript: string;

  constructor(opts: StreamerOpts) {
    this.opts = opts;
    this.cacheLogBin = join(opts.repoDir, "ci3", "cache_log");
    this.denoiseScript = join(opts.repoDir, "ci3", "denoise");
  }

  private writeActivity(type: string, text: string, isSubagent = false): void {
    try {
      const event: ActivityEvent = { ts: new Date().toISOString(), type, text, log_id: this.opts.parentLogId };
      if (isSubagent) event.subagent = true;
      appendFileSync(this.opts.activityLog, JSON.stringify(event) + "\n");
    } catch {}
  }

  private emit(text: string): void {
    this.opts.onOutput?.(text + "\n");
  }

  private spillToLog(content: string, label: string): boolean {
    if (!existsSync(this.cacheLogBin)) return false;
    const spillId = randomBytes(16).toString("hex");
    try {
      spawnSync(this.cacheLogBin, [`claudebox-${label}`, spillId], {
        input: content,
        timeout: 10_000,
        stdio: ["pipe", "ignore", "ignore"],
      });
      return true;
    } catch { return false; }
  }

  private smartTrunc(s: string, label: string, inlineLimit = 200): string {
    if (s.length <= SPILL_THRESHOLD) return s;
    this.spillToLog(s, label); // archive full content
    return trunc(s, inlineLimit);
  }

  /** Process a parsed JSONL entry from main session or subagent. */
  private processEntry(d: any, isSubagent: boolean, subLabel?: string): void {
    const t = d.type ?? "";

    if (["file-history-snapshot", "system"].includes(t)) return;

    // ── Subagent progress events ────────────────────────────────
    if (t === "progress") {
      const data = d.data ?? {};
      if (data.type === "hook_progress") return;
      const msg = data.message ?? {};
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const item of msg.message.content) {
          if (item.type === "tool_use") {
            const name = item.name ?? "?";
            const inp = item.input ?? {};
            const desc = inp.description ?? inp.command ?? inp.file_path ?? inp.pattern ?? "";
            this.emit(`  subagent ${name} ${trunc(desc, 120)}`);
            // Write subagent tool activity — tagged so UI nests it inside AgentSection
            this.writeToolActivity(name, inp, true);
          }
        }
      }
      return;
    }

    // ── Queued messages ─────────────────────────────────────────
    if (t === "queue-operation") {
      const content = d.content ?? "";
      if (d.operation === "enqueue" && content) {
        this.emit(`[queued] ${trunc(content.replace(/\n/g, " "), 120)}`);
      }
      return;
    }

    // ── User messages ───────────────────────────────────────────
    if (t === "user") {
      const msg = d.message ?? {};
      const content = msg.content ?? "";
      if (typeof content === "string") {
        this.emit(`USER: ${this.smartTrunc(content, "user-msg")}`);
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === "tool_result") {
            const res = this.extractToolResult(item);
            const err = item.is_error ?? false;
            const label = err ? "ERROR" : "RESULT";
            const disp = this.smartTrunc(res, "tool-result");
            this.emit(`  ${label}: ${disp}`);
            // Write tool results to activity for MCP tools (get_context etc.)
            if (res.trim()) {
              this.writeActivity("tool_result", trunc(res, 600), isSubagent);
            }
          } else if (item.type === "text" && item.text?.trim()) {
            this.emit(`USER: ${this.smartTrunc(item.text, "user-msg")}`);
          }
        }
      }
      return;
    }

    // ── Assistant messages ───────────────────────────────────────
    if (t === "assistant") {
      const msg = d.message ?? {};
      const content = msg.content ?? [];
      if (!Array.isArray(content)) return;

      for (const item of content) {
        const it = item.type ?? "";

        if (it === "thinking" && item.thinking?.trim()) {
          this.emit(`THINKING: ${this.smartTrunc(item.thinking.replace(/\n/g, " "), "thinking")}`);
        }

        if (it === "text" && item.text?.trim()) {
          if (!isSubagent) {
            this.writeActivity("context", item.text.trim());
          }
          this.emit(`CLAUDE: ${item.text}`);
        }

        if (it === "tool_use") {
          const name = item.name ?? "?";
          const inp = item.input ?? {};

          // Write activity event for the status page
          this.writeToolActivity(name, inp, isSubagent);

          // Pretty-print for cache log
          this.emitToolUse(name, inp);
        }
      }

      const usage = msg.usage ?? {};
      const itok = usage.input_tokens ?? 0;
      const otok = usage.output_tokens ?? 0;
      if (itok || otok) {
        this.emit(`  tokens: in=${itok} out=${otok}`);
      }
      return;
    }

    if (t === "summary") {
      this.emit("[session summary]");
      return;
    }

    // Unknown event types
    if (t && !["result", "init"].includes(t)) {
      this.emit(`[${t}] ${trunc(JSON.stringify(d), 400)}`);
    }
  }

  private writeToolActivity(name: string, inp: any, isSubagent = false): void {
    const w = (type: string, text: string) => this.writeActivity(type, text, isSubagent);
    if (name === "Agent" && inp.description) {
      w("agent_start", inp.description);
    } else if (name === "Bash" && inp.command) {
      const desc = inp.description ? `${inp.description}: ` : "";
      const cmd = inp.command.length > 120 ? inp.command.slice(0, 120) + "…" : inp.command;
      w("tool_use", `${desc}$ ${cmd}`);
    } else if (name === "Grep") {
      const path = inp.path || inp.file_path || "";
      w("tool_use", `Grep ${trunc(inp.pattern || "", 60)} ${path}`);
    } else if (["Read", "Glob"].includes(name)) {
      const target = inp.file_path || inp.pattern || inp.path || "";
      w("tool_use", `${name} ${trunc(target, 80)}`);
    } else if (["Edit", "Write"].includes(name)) {
      w("tool_use", `${name} ${inp.file_path || ""}`);
    } else if (name === "ToolSearch") {
      w("tool_use", `ToolSearch ${inp.query || ""}`);
    } else if (name.startsWith("mcp__claudebox__")) {
      const short = name.replace("mcp__claudebox__", "");
      const args = Object.entries(inp).filter(([_, v]) => v !== undefined && v !== "").map(([k, v]) => {
        const s = String(v);
        return `${k}=${s.length > 60 ? s.slice(0, 60) + "…" : s}`;
      }).join(" ");
      w("tool_use", `${short}${args ? " " + args : ""}`);
    } else if (!["mcp__ide__getDiagnostics", "mcp__ide__executeCode", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(name)) {
      const args = Object.entries(inp).filter(([_, v]) => v !== undefined && v !== "").slice(0, 3).map(([k, v]) => {
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        return `${k}=${s.length > 40 ? s.slice(0, 40) + "…" : s}`;
      }).join(" ");
      w("tool_use", `${name}${args ? " " + args : ""}`);
    }
  }

  private emitToolUse(name: string, inp: any): void {
    if (name === "Bash") {
      const cmd = inp.command ?? "";
      const desc = inp.description ?? "";
      this.emit(`TOOL: ${name} ${desc}`);
      this.emit(`  $ ${this.smartTrunc(cmd, "bash-cmd", 400)}`);
    } else if (name === "Edit" || name === "Write") {
      this.emit(`TOOL: ${name} ${inp.file_path ?? ""}`);
    } else if (["Read", "Glob", "Grep"].includes(name)) {
      const fp = inp.file_path ?? inp.path ?? inp.pattern ?? "";
      const extra = name === "Grep" ? ` pattern=${inp.pattern ?? ""}` : "";
      this.emit(`TOOL: ${name} ${fp}${extra}`);
    } else if (name === "Agent") {
      this.emit(`TOOL: Agent(${inp.subagent_type ?? ""}) ${inp.description ?? ""}`);
    } else {
      const raw = JSON.stringify(inp);
      this.emit(`TOOL: ${name} ${this.smartTrunc(raw, `tool-${name.replace(/[^a-z0-9]/gi, "")}`, 200)}`);
    }
  }

  private extractToolResult(item: any): string {
    let res = item.content ?? "";
    if (Array.isArray(res)) {
      res = res.filter((r: any) => r.type === "text").map((r: any) => r.text ?? "").join("\n");
    } else if (typeof res !== "string") {
      res = String(res);
    }
    return res;
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Start streaming. Waits for JSONL to appear, then tails in real-time.
   * Returns a promise that resolves when stop() is called.
   */
  async start(): Promise<void> {
    const { projectDir } = this.opts;

    // Wait for JSONL to appear (Claude takes a moment to start writing)
    let jsonlPath: string | null = null;
    for (let i = 0; i < 120 && !jsonlPath && !this.stopped; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (existsSync(projectDir)) jsonlPath = findNewestJsonl(projectDir);
    }
    if (!jsonlPath || this.stopped) return;

    this.emit(`━━━ Claude Session Output ━━━`);

    const mainTailer = new JsonlTailer(jsonlPath, "", (d) => this.processEntry(d, false));
    this.tailers.set(jsonlPath, mainTailer);
    mainTailer.drain();

    // Poll for new files (subagents) and drain all tailers
    const poll = () => {
      if (this.stopped) return;
      this.discoverNewFiles();
      for (const t of this.tailers.values()) t.drain();
    };

    // Watch + poll (fs.watch can be unreliable in Docker bind mounts)
    try {
      this.watcher = watch(projectDir, { recursive: true, persistent: false }, () => poll());
    } catch {}
    this.pollTimer = setInterval(poll, 2000);

    // Wait until stopped
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.stopped) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }

  /** Stop streaming — flush all tailers. */
  stop(): void {
    this.stopped = true;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }

    // Final drain + flush
    this.discoverNewFiles();
    for (const t of this.tailers.values()) {
      t.drain();
      t.flush();
    }

    this.emit(`━━━ End of Session Output ━━━`);
  }

  private discoverNewFiles(): void {
    const { projectDir } = this.opts;
    if (!existsSync(projectDir)) return;

    for (const f of findAllJsonl(projectDir)) {
      if (this.tailers.has(f)) continue;
      const isSubagent = f.includes("/subagents/");
      const label = isSubagent
        ? basename(f, ".jsonl").replace(/^agent-/, "subagent-").slice(0, 20)
        : "";

      const tailer = new JsonlTailer(f, label, (d) => this.processEntry(d, isSubagent, label));
      this.tailers.set(f, tailer);

      if (isSubagent) {
        // Create a sub-log for the subagent
        this.emit(`[subagent] ${label} started`);
        this.startSubagentLog(tailer, label);
      }
    }
  }

  private startSubagentLog(tailer: JsonlTailer, _label: string): void {
    if (!existsSync(this.denoiseScript)) return;
    try {
      const proc = spawn(this.denoiseScript, ["cat"], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, DENOISE: "1", DENOISE_DISPLAY_NAME: _label, root: this.opts.repoDir },
      });
      proc.stdout?.on("data", (chunk: Buffer) => {
        // Forward subagent output to main cache log
        this.opts.onOutput?.(chunk.toString());
      });
      tailer.subLogProc = proc;
    } catch {}
  }
}

// ── JsonlTailer ─────────────────────────────────────────────────

class JsonlTailer {
  path: string;
  private fd: number;
  private offset = 0;
  private leftover = "";
  label: string;
  subLogProc: ChildProcess | null = null;
  private onEntry: (d: any) => void;
  private finished = false;
  private entryCount = 0;

  constructor(path: string, label: string, onEntry: (d: any) => void) {
    this.path = path;
    this.label = label;
    this.onEntry = onEntry;
    this.fd = openSync(path, "r");
  }

  drain(): boolean {
    if (this.finished) return false;
    const size = fstatSync(this.fd).size;
    if (size <= this.offset) return false;

    const buf = Buffer.alloc(size - this.offset);
    readSync(this.fd, buf, 0, buf.length, this.offset);
    const text = this.leftover + buf.toString("utf-8");
    const parts = text.split("\n");
    this.leftover = parts.pop() ?? "";
    this.offset = size;

    let found = false;
    for (const line of parts) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (this.label && this.subLogProc?.stdin?.writable) {
          // Pipe subagent output to its denoise process
          this.subLogProc.stdin.write(line + "\n");
        }
        this.onEntry(d);
        this.entryCount++;
        found = true;

        if (d.type === "result" && this.label) {
          this.flush();
          return found;
        }
      } catch {}
    }
    return found;
  }

  flush(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.leftover.trim()) {
      try {
        const d = JSON.parse(this.leftover);
        this.onEntry(d);
      } catch {}
    }
    try { closeSync(this.fd); } catch {}
    if (this.subLogProc?.stdin?.writable) {
      this.subLogProc.stdin.end();
    }
  }
}
