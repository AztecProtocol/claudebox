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

// Set env var early so config.ts sees it during import
if (process.argv.includes("--http-only")) process.env.CLAUDEBOX_HTTP_ONLY = "1";
const HTTP_ONLY = process.env.CLAUDEBOX_HTTP_ONLY === "1";

import {
  SLACK_APP_TOKEN, HTTP_PORT, INTERNAL_PORT, DOCKER_IMAGE, MAX_CONCURRENT,
  CLAUDEBOX_DIR,
} from "./packages/libclaudebox/config.ts";
import { setChannelMaps } from "./packages/libclaudebox/runtime.ts";

// SLACK_BOT_TOKEN via libcreds-host — needed for Slack Bolt App initialization.
import { getSlackBotToken } from "./packages/libcreds-host/index.ts";
const SLACK_BOT_TOKEN = getSlackBotToken();
import { WorktreeStore } from "./packages/libclaudebox/worktree-store.ts";
import { DockerService } from "./packages/libclaudebox/docker.ts";
import { createHttpServer } from "./packages/libclaudebox/http-routes.ts";
import { DmRegistry } from "./packages/libclaudebox/dm-registry.ts";
import { setProfilesDir, buildChannelProfileMap, buildChannelBranchMap, loadAllProfiles } from "./packages/libclaudebox/profile-loader.ts";
import { ProfileRuntime } from "./packages/libclaudebox/profile.ts";
import { startAutoUpdate } from "./packages/libclaudebox/auto-update.ts";
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
  setProfilesDir(join(rootDir, "profiles"));

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
  const store = new WorktreeStore();
  const docker = new DockerService();

  // ── Reconcile stale sessions (async — won't block event loop) ──
  let reconciling = false;
  const runReconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try { await store.reconcileAsync(docker); } catch (e: any) {
      console.error(`[RECONCILE] Error: ${e.message}`);
    } finally { reconciling = false; }
  };
  // Run reconcile first, then recover — reconcile cleans up dead containers,
  // recover re-attaches to containers that are still running.
  runReconcile().then(() => {
    docker.recoverRunningSessions(store).catch(e => {
      console.error(`[RECOVER] Error: ${e.message}`);
    });
  });
  setInterval(runReconcile, 60_000);

  // ── DM registry ──
  const dmRegistry = new DmRegistry(join(CLAUDEBOX_DIR, "dm-registry.json"));

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

  // ── Load profiles and set up runtime ──
  const profiles = await loadAllProfiles(requestedProfiles.length ? requestedProfiles : undefined);
  const profileRuntime = new ProfileRuntime(docker, store);
  for (const profile of profiles) {
    await profileRuntime.loadProfile(profile);
  }
  const profileRoutes = profileRuntime.getRoutes();
  if (profileRoutes.length) console.log(`  Profile routes: ${profileRoutes.length} endpoints`);

  // ── HTTP servers ──
  const { public: publicServer, internal: internalServer } = createHttpServer(store, docker, profileRuntime, dmRegistry);

  publicServer.listen(HTTP_PORT, () => {
    console.log(`  HTTP (public) listening on :${HTTP_PORT}`);
  });

  internalServer.listen(INTERNAL_PORT, () => {
    console.log(`  HTTP (internal) listening on :${INTERNAL_PORT}`);
  });

  // ── Auto-update (polls origin/next, restarts on new commits) ──
  if (process.argv.includes("--auto-update")) {
    startAutoUpdate(rootDir);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
