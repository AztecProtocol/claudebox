/**
 * MCP HTTP server scaffold — profiles call startMcpHttpServer() to start.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { PORT, SESSION_META } from "./env.ts";
import {
  getServerClient, logActivity, addProgress, updateRootComment, buildSlackText,
  lastStatus, respondToUserCalled, trackedPRs, otherArtifacts,
} from "./activity.ts";
import { getCreds, _hasGhToken, _hasSlackToken, _hasLinearToken, readBody, parseSlackPermalink } from "./helpers.ts";

// ── Completion summary ──────────────────────────────────────────

function buildCompletionSummary(): string {
  if (respondToUserCalled && lastStatus) return lastStatus;

  const parts: string[] = [];
  try {
    const projDir = join(process.env.HOME || "/home/claude", ".claude", "projects", "-workspace");
    if (existsSync(projDir)) {
      const files = readdirSync(projDir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => ({ name: f, mtime: statSync(join(projDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        const lines = readFileSync(join(projDir, files[0].name), "utf-8").split("\n").filter(l => l.trim());
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const d = JSON.parse(lines[i]);
            if (d.type === "assistant" && Array.isArray(d.message?.content)) {
              for (const item of d.message.content) {
                if (item.type === "text" && item.text?.trim()) {
                  parts.push(item.text.trim());
                  break;
                }
              }
              if (parts.length) break;
            }
          } catch {}
        }
      }
    }
  } catch {}

  const artifactCount = trackedPRs.size + otherArtifacts.length;
  if (artifactCount > 0) {
    const prList = [...trackedPRs.entries()].map(([num, pr]) =>
      `${pr.action === "created" ? "created" : "updated"} #${num}`
    );
    if (prList.length) parts.push(`PRs: ${prList.join(", ")}`);
  }

  if (parts.length === 0) return "Session completed";
  return parts.join(" | ");
}

async function dmAuthorOnCompletion(): Promise<void> {
  if (!SESSION_META.user) return;
  if (SESSION_META.slack_channel && SESSION_META.slack_channel.startsWith("D")) return;

  const client = getServerClient();
  if (!client.hasServer) return;

  const hasError = lastStatus?.includes("error");
  const status = hasError ? "Task failed" : "Task done";
  await client.dmAuthor({
    status,
    trackedPRs: [...trackedPRs.entries()].map(([num, pr]) => ({ num, ...pr })),
  });
}

async function initSlackFromPermalink(): Promise<void> {
  if (!SESSION_META.slack_channel || !SESSION_META.slack_thread_ts || SESSION_META.slack_message_ts) return;
  if (!_hasSlackToken()) return;

  const initText = buildSlackText("Starting…");
  const slack = getCreds().slack;

  try {
    const d = await slack.updateMessage(initText, {
      channel: SESSION_META.slack_channel, ts: SESSION_META.slack_thread_ts,
    });
    if (d.ok) {
      SESSION_META.slack_message_ts = SESSION_META.slack_thread_ts;
      getServerClient().updateSessionMeta({ slack_message_ts: SESSION_META.slack_message_ts });
      console.log(`[Sidecar] Updated linked message directly in ${SESSION_META.slack_channel}, ts=${SESSION_META.slack_thread_ts}`);
      return;
    }
    console.log(`[Sidecar] Can't update linked message (${d.error}), posting thread reply`);
  } catch (e: any) {
    console.log(`[Sidecar] Can't update linked message (${e.message}), posting thread reply`);
  }

  try {
    const d = await slack.postMessage(initText, {
      channel: SESSION_META.slack_channel, threadTs: SESSION_META.slack_thread_ts,
    });
    if (d.ok && d.ts) {
      SESSION_META.slack_message_ts = d.ts;
      getServerClient().updateSessionMeta({ slack_message_ts: d.ts });
      console.log(`[Sidecar] Posted thread reply in ${SESSION_META.slack_channel}, ts=${d.ts}`);
    } else {
      console.error(`[Sidecar] Failed to post thread reply: ${d.error}`);
    }
  } catch (e: any) {
    console.error(`[Sidecar] Failed to post thread reply: ${e.message}`);
  }
}

// ── Parse Slack permalink from link if no Slack coords provided ──
if (_hasSlackToken() && SESSION_META.link && !SESSION_META.slack_channel) {
  const parsed = parseSlackPermalink(SESSION_META.link);
  if (parsed) {
    SESSION_META.slack_channel = parsed.channel;
    SESSION_META.slack_thread_ts = parsed.thread_ts;
  }
}

// ── HTTP Server ─────────────────────────────────────────────────

export function startMcpHttpServer(createMcpServer: () => McpServer): void {
  const MCP_PATH = "/mcp";

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    if (req.url === MCP_PATH && req.method === "POST") {
      try {
        const bodyStr = await readBody(req);
        const body = JSON.parse(bodyStr);
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      } catch (error: any) {
        console.error("MCP error:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[Sidecar] :${PORT} gh=${_hasGhToken() ? "yes" : "no"} slack=${_hasSlackToken() ? "yes" : "no"} linear=${_hasLinearToken() ? "yes" : "no"}`);
    initSlackFromPermalink();
  });

  process.on("SIGTERM", async () => {
    try {
      httpServer.close();

      if (!respondToUserCalled) {
        const summary = buildCompletionSummary();
        if (summary !== "Session completed") {
          logActivity("response", summary);
          addProgress("response", summary);
        }
      }

      const completionStatus = lastStatus
        ? `${lastStatus} — _completed_`
        : "_completed_";
      addProgress("status", "Session completed");
      await updateRootComment(completionStatus);
      await dmAuthorOnCompletion();
    } catch (e) {
      console.error(`[SIGTERM] Cleanup error: ${e}`);
    }
    process.exit(0);
  });
}
