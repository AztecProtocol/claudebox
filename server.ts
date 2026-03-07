#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox Server — combined Slack listener + HTTP API.
 *
 * Modes:
 *   Full:      Slack Socket Mode + HTTP API (default)
 *   HTTP-only: node server.ts --http-only  (no Slack tokens required)
 *
 * Max 10 concurrent sessions.
 */

// ── Aztec-specific config (sets env defaults before config.ts evaluates) ──
import "./aztec/config.ts";

// Set env var early so config.ts sees it during import
if (process.argv.includes("--http-only")) process.env.CLAUDEBOX_HTTP_ONLY = "1";
const HTTP_ONLY = process.env.CLAUDEBOX_HTTP_ONLY === "1";

import { WebSocketServer } from "ws";
import {
  SLACK_BOT_TOKEN, SLACK_APP_TOKEN, HTTP_PORT, DOCKER_IMAGE, MAX_CONCURRENT,
  SESSION_PAGE_USER, SESSION_PAGE_PASS, CLAUDEBOX_DIR, setChannelMaps,
} from "./packages/libclaudebox/config.ts";
import { SessionStore } from "./packages/libclaudebox/session-store.ts";
import { DockerService } from "./packages/libclaudebox/docker.ts";
import { InteractiveSessionManager } from "./packages/libclaudebox/interactive.ts";
import { createHttpServer } from "./packages/libclaudebox/http-routes.ts";
import { QuestionStore } from "./packages/libclaudebox/question-store.ts";
import { DmRegistry } from "./packages/libclaudebox/dm-registry.ts";
import { setPluginsDir, buildChannelProfileMap, buildChannelBranchMap, loadAllPlugins } from "./packages/libclaudebox/plugin-loader.ts";
import { PluginRuntime } from "./packages/libclaudebox/plugin.ts";
import { join, dirname } from "path";

// Prevent unhandled Slack/WebSocket rejections from crashing the process
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message || String(reason);
  if (msg.includes("invalid_auth") || msg.includes("slack")) {
    console.warn(`[UNHANDLED] Slack error suppressed: ${msg}`);
  } else {
    console.error(`[UNHANDLED] Rejection: ${msg}`);
  }
});

async function main() {
  // ── Parse --profiles flag ──
  const profilesArg = process.argv.find(a => a.startsWith("--profiles="))?.split("=")[1]
    || (process.argv.indexOf("--profiles") >= 0 ? process.argv[process.argv.indexOf("--profiles") + 1] : "");
  const requestedProfiles = profilesArg ? profilesArg.split(",").map(p => p.trim()).filter(Boolean) : [];

  // ── Discover profiles and build channel maps ──
  const rootDir = dirname(import.meta.url.replace("file://", ""));
  setPluginsDir(join(rootDir, "profiles"));

  const profileMap = await buildChannelProfileMap();
  const branchMap = await buildChannelBranchMap();

  // Filter to requested profiles if specified
  if (requestedProfiles.length > 0) {
    for (const [ch, prof] of profileMap) {
      if (!requestedProfiles.includes(prof)) profileMap.delete(ch);
    }
  }

  setChannelMaps(
    Object.fromEntries(branchMap),
    Object.fromEntries(profileMap),
  );

  console.log("ClaudeBox server starting...");
  console.log(`  Image: ${DOCKER_IMAGE}`);
  console.log(`  Profiles: ${requestedProfiles.length ? requestedProfiles.join(", ") : "(all)"}`);
  console.log(`  Mode: ${HTTP_ONLY ? "HTTP-only" : "Slack + HTTP"}`);
  console.log(`  HTTP:  port ${HTTP_PORT}`);
  console.log(`  Max concurrent: ${MAX_CONCURRENT}`);

  // ── Instantiate services ──
  const store = new SessionStore();
  const docker = new DockerService();
  const interactive = new InteractiveSessionManager(docker, store);

  // ── Reconcile stale sessions (async — won't block event loop) ──
  let reconciling = false;
  const runReconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try { await store.reconcileAsync(docker); } catch (e: any) {
      console.error(`[RECONCILE] Error: ${e.message}`);
    } finally { reconciling = false; }
  };
  runReconcile();
  setInterval(runReconcile, 60_000);

  // ── DM registry ──
  const dmRegistry = new DmRegistry(join(CLAUDEBOX_DIR, "dm-registry.json"));

  // ── Question expiry timer ──
  const questionStore = new QuestionStore();
  setInterval(() => {
    try {
      const resolved = questionStore.expireOverdue();
      for (const worktreeId of resolved) {
        console.log(`[QUESTIONS] All questions resolved for ${worktreeId} — auto-resuming`);
        const session = store.findByWorktreeId(worktreeId);
        if (session && session.status !== "running" && store.isWorktreeAlive(worktreeId)) {
          const prompt = questionStore.buildResumePrompt(worktreeId);
          docker.runContainerSession({
            prompt,
            userName: session.user || "auto-resume",
            worktreeId,
            targetRef: session.base_branch ? `origin/${session.base_branch}` : undefined,
            profile: session.profile || undefined,
          }, store).catch(e => {
            console.error(`[QUESTIONS] Auto-resume failed for ${worktreeId}: ${e.message}`);
          });
        }
      }
    } catch (e: any) {
      console.error(`[QUESTIONS] Expiry check error: ${e.message}`);
    }
  }, 60_000);

  // ── Worktree GC — keep workspace dirs under 100GB, clean oldest first ──
  let gcRunning = false;
  const runGC = async () => {
    if (gcRunning) return;
    gcRunning = true;
    try {
      const cleaned = await store.gcWorktreesAsync(100, 1); // 100GB budget, min 1 day old
      if (cleaned.length > 0) console.log(`[GC] Cleaned ${cleaned.length} worktrees: ${cleaned.join(", ")}`);
    } catch (e: any) {
      console.error(`[GC] Error: ${e.message}`);
    } finally { gcRunning = false; }
  };
  setTimeout(runGC, 30_000);
  setInterval(runGC, 6 * 60 * 60 * 1000); // every 6h instead of daily — more gradual

  // ── Slack app (skipped in HTTP-only mode) ──
  if (!HTTP_ONLY) {
    try {
      const { App } = await import("@slack/bolt");
      const { registerSlackHandlers } = await import("./packages/libclaudebox/slack/handlers.ts");
      const slackApp = new App({
        token: SLACK_BOT_TOKEN,
        appToken: SLACK_APP_TOKEN,
        socketMode: true,
        port: HTTP_PORT + 1, // Bolt creates its own HTTP server; avoid conflicting with ours
      });
      slackApp.error(async (error) => {
        console.error(`[SLACK_ERROR] ${error.message || error}`);
      });
      slackApp.use(async ({ body, next }) => {
        const eventType = (body as any)?.event?.type || (body as any)?.type || "unknown";
        const channelType = (body as any)?.event?.channel_type || "";
        console.log(`[SLACK_RAW] type=${eventType} channel_type=${channelType}`);
        await next();
      });
      registerSlackHandlers(slackApp, store, docker, dmRegistry);
      await slackApp.start();
      console.log("  Slack connected.");
    } catch (e: any) {
      console.warn(`  Slack failed: ${e.message} (HTTP server will still run)`);
    }
  } else {
    console.log("  Slack: skipped (HTTP-only mode)");
  }

  // ── Load plugins and set up runtime ──
  const plugins = await loadAllPlugins(requestedProfiles.length ? requestedProfiles : undefined);
  const pluginRuntime = new PluginRuntime(docker, store);
  for (const plugin of plugins) {
    await pluginRuntime.loadPlugin(plugin);
  }
  const pluginRoutes = pluginRuntime.getRoutes();
  if (pluginRoutes.length) console.log(`  Plugin routes: ${pluginRoutes.length} endpoints`);

  // ── HTTP server ──
  const httpServer = createHttpServer(store, docker, interactive, pluginRuntime, dmRegistry);

  // ── WebSocket upgrade (requires basic auth) ──
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const m = req.url?.match(/^\/s\/([a-f0-9][\w-]+)\/ws$/);
    if (!m) { socket.destroy(); return; }
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Basic ")) { socket.destroy(); return; }
    const [u, p] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    if (u !== SESSION_PAGE_USER || p !== SESSION_PAGE_PASS) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket as any, head, (ws) => {
      interactive.handleWs(m[1], ws).catch((e) => {
        console.error(`[INTERACTIVE] WS error: ${e.message}`);
        ws.close(1011, (e.message || "error").slice(0, 120));
      });
    });
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`  HTTP listening on :${HTTP_PORT}`);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
