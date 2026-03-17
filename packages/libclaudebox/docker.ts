import Docker from "dockerode";
import { execFileSync, execSync, spawn, type ChildProcess } from "child_process";
import { existsSync, writeFileSync, realpathSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type { ContainerSessionOpts, WorktreeInfo, RunMeta } from "./types.ts";
import type { WorktreeStore } from "./worktree-store.ts";
import { SessionStreamer } from "./session-streamer.ts";
import {
  REPO_DIR, DOCKER_IMAGE, CLAUDEBOX_CODE_DIR, CLAUDE_BINARY,
  BASTION_SSH_KEY, INTERNAL_PORT,
  CLAUDEBOX_HOST, CLAUDEBOX_DIR, CLAUDEBOX_STATS_DIR, API_SECRET,
  buildLogUrl,
} from "./config.ts";
import { incrActiveSessions, decrActiveSessions } from "./runtime.ts";
import { updateGithubOnCompletion } from "./github-completion.ts";

// Token env vars — sourced from libcreds-host (the only package that reads token env vars).
import { getContainerTokens } from "../libcreds-host/index.ts";
import { loadProfile } from "./profile-loader.ts";
import type { DockerConfig } from "./profile.ts";

// Container user — must match the image's primary user (aztec-dev, uid 30079).
const CONTAINER_USER = process.env.CLAUDEBOX_CONTAINER_USER || "aztec-dev";
const CONTAINER_HOME = `/home/${CONTAINER_USER}`;

// Host git identity — passed into containers so git commit works
function getGitIdentity(): { name: string; email: string } {
  try {
    const name = execFileSync("git", ["config", "user.name"], { encoding: "utf-8", timeout: 5_000 }).trim();
    const email = execFileSync("git", ["config", "user.email"], { encoding: "utf-8", timeout: 5_000 }).trim();
    return { name, email };
  } catch {
    return { name: "", email: "" };
  }
}

const GIT_IDENTITY = getGitIdentity();

export class DockerService {
  docker: Docker;

  constructor(socketPath = "/var/run/docker.sock") {
    this.docker = new Docker({ socketPath });
  }

  // ── Sync helpers (for reconcile, cleanup — must be non-async) ──

  inspectContainerSync(name: string): { running: boolean; exitCode: number } {
    try {
      const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name], {
        encoding: "utf-8", timeout: 5_000,
      }).trim().split(" ");
      return { running: out[0] === "true", exitCode: parseInt(out[1], 10) || 1 };
    } catch {
      return { running: false, exitCode: 1 };
    }
  }

  forceRemoveSync(name: string): void {
    try { execFileSync("docker", ["rm", "-f", name], { timeout: 10_000 }); } catch {}
  }

  stopAndRemoveSync(name: string, timeout = 5): void {
    try { execFileSync("docker", ["stop", "-t", String(timeout), name], { timeout: 30_000 }); } catch {}
    try { execFileSync("docker", ["rm", "-f", name], { timeout: 10_000 }); } catch {}
  }

  removeNetworkSync(name: string): void {
    try { execFileSync("docker", ["network", "rm", name], { timeout: 10_000 }); } catch {}
  }

  // ── Async helpers ─────────────────────────────────────────────

  async createNetwork(name: string): Promise<void> {
    await this.docker.createNetwork({ Name: name });
  }

  async removeNetwork(name: string): Promise<void> {
    try { await this.docker.getNetwork(name).remove(); } catch {}
  }

  async stopAndRemove(name: string, timeout = 5): Promise<void> {
    try {
      const c = this.docker.getContainer(name);
      await c.stop({ t: timeout });
    } catch {}
    try { await this.docker.getContainer(name).remove({ force: true }); } catch {}
  }

  async waitForHealth(containerName: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const exec = await this.docker.getContainer(containerName).exec({
          Cmd: ["curl", "-sf", "http://127.0.0.1:9801/health"],
          AttachStdout: true,
        });
        const stream = await exec.start({});
        const out = await new Promise<string>((resolve) => {
          let data = "";
          stream.on("data", (d: Buffer) => data += d.toString());
          stream.on("end", () => resolve(data));
          setTimeout(() => resolve(data), 3000);
        });
        if (out.includes("ok")) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Sidecar health check timed out after ${timeoutMs}ms`);
  }

  // ── Full session runner ───────────────────────────────────────

  async runContainerSession(
    opts: ContainerSessionOpts,
    store: WorktreeStore,
    onOutput?: (data: string) => void,
    onStart?: (logUrl: string, worktreeId: string) => void,
  ): Promise<number> {
    incrActiveSessions();

    // Resolve worktree first (needed for logId)
    const wt = store.getOrCreateWorktree(opts.worktreeId);
    const { worktreeId, workspaceDir, claudeProjectsDir } = wt;

    // Kill any leftover containers from previous runs on this worktree
    const prevSessions = store.listByWorktree(worktreeId);
    for (const prev of prevSessions) {
      if (prev.status === "running" && prev._log_id) {
        const prevContainer = prev.container || `claudebox-${prev._log_id}`;
        const prevSidecar = prev.sidecar || `claudebox-sidecar-${prev._log_id}`;
        const prevNetwork = `claudebox-net-${prev._log_id}`;
        this.stopAndRemoveSync(prevContainer, 3);
        this.stopAndRemoveSync(prevSidecar, 3);
        this.removeNetworkSync(prevNetwork);
        store.update(prev._log_id, { status: "cancelled", exit_code: 137, finished: new Date().toISOString() });
        console.log(`[DOCKER] Cleaned up previous run ${prev._log_id} on worktree ${worktreeId}`);
      }
    }

    const logId = store.nextSessionLogId(worktreeId);
    const sessionUuid = randomUUID();
    const networkName = `claudebox-net-${logId}`;
    const sidecarName = `claudebox-sidecar-${logId}`;
    const claudeName = `claudebox-${logId}`;
    const logUrl = buildLogUrl(logId);
    const mcpUrl = `http://${sidecarName}:9801/mcp`;

    onStart?.(logUrl, worktreeId);
    const parentLogId = opts.worktreeId ? store.getWorktreeParentLogId(worktreeId) : "";

    // Fix ownership
    try { execSync(`chown -R ${process.getuid!()}:${process.getgid!()} "${workspaceDir}"`, { timeout: 10_000 }); } catch {}

    // Profile-aware paths (validate name to prevent path traversal)
    const profileDir = opts.profile || "default";
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profileDir)) {
      throw new Error(`Invalid profile name: ${profileDir}`);
    }
    const sidecarEntrypoint = `/opt/claudebox/profiles/${profileDir}/mcp-sidecar.ts`;
    const profile = await loadProfile(profileDir);
    const dockerConfig = profile.docker || {};
    const containerImage = dockerConfig.image || DOCKER_IMAGE;
    console.log(`[DOCKER] Starting session ${logId} (worktree=${worktreeId} profile=${profileDir})`);
    console.log(`[DOCKER]   Sidecar:   ${sidecarName}`);
    console.log(`[DOCKER]   Claude:    ${claudeName}`);
    console.log(`[DOCKER]   Network:   ${networkName}`);
    console.log(`[DOCKER]   Worktree:  ${worktreeId}`);
    console.log(`[DOCKER]   Workspace: ${workspaceDir}`);
    console.log(`[DOCKER]   Profile:   ${profileDir}`);
    console.log(`[DOCKER]   Log URL:   ${logUrl}`);

    // Write prompt file (with profile promptSuffix appended)
    const baseBranch = opts.targetRef?.replace("origin/", "") || "next";
    let fullPrompt = opts.prompt;
    fullPrompt += `\n\nLog URL: ${logUrl}`;
    fullPrompt += `\nBase branch: ${baseBranch}`;
    fullPrompt += `\nTarget ref: ${opts.targetRef || "origin/next"}`;
    if (opts.runUrl) fullPrompt += `\nRun URL: ${opts.runUrl}`;
    if (opts.link) fullPrompt += `\nLink: ${opts.link}`;
    const promptSuffix = profile.promptSuffix || "";
    if (promptSuffix) fullPrompt += `\n\n${promptSuffix}`;
    writeFileSync(join(workspaceDir, "prompt.txt"), fullPrompt);

    // Write session metadata
    const metadata: any = {
      prompt: opts.prompt,
      user: opts.userName || "unknown",
      container: claudeName,
      sidecar: sidecarName,
      log_url: logUrl,
      link: opts.link || opts.runUrl || "",
      slack_channel: opts.slackChannel || "",
      slack_channel_name: opts.slackChannelName || "",
      slack_thread_ts: opts.slackThreadTs || "",
      slack_message_ts: opts.slackMessageTs || "",
      run_comment_id: opts.runCommentId || "",
      comment_id: opts.commentId || "",
      repo: basename(REPO_DIR) === "aztec-packages" ? "AztecProtocol/aztec-packages" : "",
      claude_session_id: sessionUuid,
      worktree_id: worktreeId,
      base_branch: baseBranch,
      profile: opts.profile || "",
      scopes: opts.scopes || [],
      started: new Date().toISOString(),
      status: "running",
    };
    store.save(logId, metadata);
    store.updateWorktreeMeta(worktreeId, logId);

    // Create network
    try {
      await this.createNetwork(networkName);
      console.log(`[DOCKER] Network created: ${networkName}`);
    } catch (e: any) {
      decrActiveSessions();
      throw new Error(`Failed to create Docker network: ${e.message}`);
    }

    const cleanup = () => {
      this.stopAndRemoveSync(sidecarName, 5);
      this.forceRemoveSync(claudeName);
      this.removeNetworkSync(networkName);
    };

    try {
      // Start sidecar
      const uid = `${process.getuid!()}:${process.getgid!()}`;
      // Build sidecar binds — audit profile skips reference repo
      const profileHostDir = join(CLAUDEBOX_CODE_DIR, "profiles", profileDir);
      const sidecarBinds = [
        `${workspaceDir}:/workspace:rw`,
        `${claudeProjectsDir}:${CONTAINER_HOME}/.claude/projects/-workspace:ro`,
        `${CLAUDEBOX_CODE_DIR}:/opt/claudebox:ro`,
        `${profileHostDir}:/opt/claudebox-profile:rw`,
        `${BASTION_SSH_KEY}:${CONTAINER_HOME}/.ssh/build_instance_key:ro`,
        `${CLAUDEBOX_STATS_DIR}:/stats:rw`,
        `${CLAUDEBOX_DIR}:${CONTAINER_HOME}/.claudebox:rw`,
      ];
      sidecarBinds.push(`${join(REPO_DIR, ".git")}:/reference-repo/.git:ro`);
      // Mount yarn-project node_modules + prettier config for format tools
      const ypNodeModules = join(REPO_DIR, "yarn-project/node_modules");
      if (existsSync(ypNodeModules)) {
        sidecarBinds.push(`${ypNodeModules}:/reference-repo/yarn-project/node_modules:ro`);
      }
      const prettierConfig = join(REPO_DIR, "yarn-project/foundation/.prettierrc.json");
      if (existsSync(prettierConfig)) {
        sidecarBinds.push(`${prettierConfig}:/reference-repo/yarn-project/foundation/.prettierrc.json:ro`);
      }

      // GCP service account — bind-mount key file; containers activate it themselves
      const gcpSaKey = join(homedir(), "claudesa.json");
      const hasGcp = existsSync(gcpSaKey);
      if (hasGcp) {
        sidecarBinds.push(`${gcpSaKey}:/opt/gcp/claudesa.json:ro`);
      }

      // Server URL for sidecar → server communication (internal port, not exposed to internet)
      const serverUrl = `http://host.docker.internal:${INTERNAL_PORT}`;

      await this.docker.createContainer({
        name: sidecarName,
        Image: containerImage,
        Entrypoint: [sidecarEntrypoint],
        User: uid,
        Env: [
          `HOME=${CONTAINER_HOME}`,
          `GIT_CONFIG_GLOBAL=/tmp/.gitconfig`,
          `GIT_AUTHOR_NAME=${GIT_IDENTITY.name}`,
          `GIT_AUTHOR_EMAIL=${GIT_IDENTITY.email}`,
          `GIT_COMMITTER_NAME=${GIT_IDENTITY.name}`,
          `GIT_COMMITTER_EMAIL=${GIT_IDENTITY.email}`,
          `MCP_PORT=9801`,
          `GH_TOKEN=${getContainerTokens().ghToken}`,
          `LINEAR_API_KEY=${getContainerTokens().linearApiKey}`,
          // Server client env — sidecar uses these to talk to host server
          `CLAUDEBOX_SERVER_URL=${serverUrl}`,
          `CLAUDEBOX_SERVER_TOKEN=${API_SECRET}`,
          `CLAUDEBOX_LOG_ID=${logId}`,
          `CLAUDEBOX_LOG_URL=${logUrl}`,
          `CLAUDEBOX_WORKTREE_ID=${worktreeId}`,
          `CLAUDEBOX_USER=${opts.userName || ""}`,
          `CLAUDEBOX_COMMENT_ID=${opts.commentId || ""}`,
          `CLAUDEBOX_RUN_COMMENT_ID=${opts.runCommentId || ""}`,
          `CLAUDEBOX_RUN_URL=${opts.runUrl || ""}`,
          `CLAUDEBOX_LINK=${opts.link || ""}`,
          `CLAUDEBOX_HOST=${CLAUDEBOX_HOST}`,
          `CLAUDEBOX_BASE_BRANCH=${baseBranch}`,
          `CLAUDEBOX_REPO_NAME=${basename(REPO_DIR)}`,
          `CLAUDEBOX_QUIET=${opts.quiet ? "1" : "0"}`,
          `CLAUDEBOX_CI_ALLOW=${opts.ciAllow ? "1" : "0"}`,
          `CLAUDEBOX_PROFILE=${profileDir}`,
          `CLAUDEBOX_SCOPES=${(opts.scopes || []).join(",")}`,
          ...(hasGcp ? [`GOOGLE_APPLICATION_CREDENTIALS=/opt/gcp/claudesa.json`] : []),
        ],
        HostConfig: {
          NetworkMode: networkName,
          ExtraHosts: ["host.docker.internal:host-gateway"],
          Binds: sidecarBinds,
        },
      }).then(c => c.start());
      console.log(`[DOCKER] Sidecar started: ${sidecarName} (profile=${profileDir} quiet=${opts.quiet ? "yes" : "no"})`);

      await this.waitForHealth(sidecarName);
      console.log(`[DOCKER] Sidecar healthy`);

      // Build Claude container args (use spawn for streaming output)
      const claudeArgs: string[] = [
        "run",
        "--name", claudeName,
        "--network", networkName,
        "--user", uid,
        "--add-host", "host.docker.internal:host-gateway",
        "-e", `HOME=${CONTAINER_HOME}`,
        "-e", `GIT_CONFIG_GLOBAL=/tmp/.gitconfig`,
        "-e", `GIT_AUTHOR_NAME=${GIT_IDENTITY.name}`,
        "-e", `GIT_AUTHOR_EMAIL=${GIT_IDENTITY.email}`,
        "-e", `GIT_COMMITTER_NAME=${GIT_IDENTITY.name}`,
        "-e", `GIT_COMMITTER_EMAIL=${GIT_IDENTITY.email}`,
        "-v", `${workspaceDir}:/workspace:rw`,
        // Mount session JSONL dir to both project keys: -workspace (initial cwd)
        // and -workspace-${basename(REPO_DIR)} (cwd after clone_repo). Without both,
        // Claude can't find prior sessions when the cwd changes after clone.
        "-v", `${join(homedir(), ".claude")}:${CONTAINER_HOME}/.claude:rw`,
        "-v", `${claudeProjectsDir}:${CONTAINER_HOME}/.claude/projects/-workspace:rw`,
        "-v", `${claudeProjectsDir}:${CONTAINER_HOME}/.claude/projects/-workspace-${basename(REPO_DIR)}:rw`,
        "-v", `${realpathSync(CLAUDE_BINARY)}:/usr/local/bin/claude:ro`,
        "-v", `${join(homedir(), ".claude.json")}:${CONTAINER_HOME}/.claude.json:rw`,
        "-v", `${CLAUDEBOX_CODE_DIR}:/opt/claudebox:ro`,
        // Profile dir mounted rw so Claude can add skills, edit CLAUDE.md, etc.
        "-v", `${join(CLAUDEBOX_CODE_DIR, "profiles", profileDir)}:/opt/claudebox-profile:rw`,
        "-e", `CLAUDEBOX_MCP_URL=${mcpUrl}`,
        "-e", `SESSION_UUID=${sessionUuid}`,
        "-e", `CLAUDEBOX_SIDECAR_HOST=${sidecarName}`,
        "-e", `CLAUDEBOX_SIDECAR_PORT=9801`,
        "-e", `PARENT_LOG_ID=${logId}`,
        "-e", `CLAUDEBOX_PROFILE=${profileDir}`,
        "-e", `CLAUDEBOX_MODEL=${opts.model || ""}`,
        "-e", `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`,
      ];
      // Pass tag categories to sidecar
      const tagCats = profile.tagCategories || [];
      if (tagCats.length) claudeArgs.push("-e", `CLAUDEBOX_TAG_CATEGORIES=${tagCats.join(",")}`);
      // Profile-specific extra env vars and bind mounts
      if (dockerConfig.extraEnv) {
        for (const e of dockerConfig.extraEnv) claudeArgs.push("-e", e);
      }
      if (dockerConfig.extraBinds) {
        for (const b of dockerConfig.extraBinds) claudeArgs.push("-v", b);
      }
      // GCP credentials
      if (hasGcp) {
        claudeArgs.push("-v", `${gcpSaKey}:/opt/gcp/claudesa.json:ro`);
        claudeArgs.push("-e", `GOOGLE_APPLICATION_CREDENTIALS=/opt/gcp/claudesa.json`);
      }
      // Mount reference repo for sparse pre-clone
      claudeArgs.push("-v", `${join(REPO_DIR, ".git")}:/reference-repo/.git:ro`);

      // Auto-detect resume
      if (opts.worktreeId) {
        const resumeId = store.findLatestClaudeSessionId(claudeProjectsDir);
        if (resumeId) {
          claudeArgs.push("-e", `CLAUDEBOX_RESUME_ID=${resumeId}`);
          console.log(`[DOCKER] Resume ID from worktree JSONL: ${resumeId}`);
        }
      }

      claudeArgs.push("--entrypoint", "bash", containerImage, "/opt/claudebox/container-entrypoint.sh");
      console.log(`[DOCKER] Starting Claude container: ${claudeName}`);

      // Run Claude container (blocking, stream output)
      return await new Promise<number>((resolve) => {
        const container = spawn("docker", claudeArgs, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Set up unified session streamer + cache_log
        let cacheLogProc: ChildProcess | null = null;
        let streamer: SessionStreamer | null = null;
        try {
          const cacheLogBin = join(REPO_DIR, "ci3", "cache_log");
          const activityLog = join(workspaceDir, "activity.jsonl");

          // Start cache_log process if available
          if (existsSync(cacheLogBin)) {
            const slackLink = opts.slackChannel && opts.slackThreadTs
              ? `https://${process.env.SLACK_WORKSPACE_DOMAIN || "slack"}.slack.com/archives/${opts.slackChannel}/p${(opts.slackMessageTs || opts.slackThreadTs).replace(".", "")}?thread_ts=${opts.slackThreadTs}&cid=${opts.slackChannel}`
              : "";
            const headerLines: string[] = [];
            if (slackLink) headerLines.push(`Slack: ${slackLink}`);
            if (opts.runUrl) headerLines.push(`GitHub: ${opts.runUrl}`);
            if (opts.link && opts.link !== opts.runUrl && opts.link !== slackLink) headerLines.push(`Link: ${opts.link}`);
            headerLines.push(`User: ${opts.userName || "unknown"}`);
            headerLines.push(`Container: ${claudeName}`);
            headerLines.push("");

            cacheLogProc = spawn(cacheLogBin, ["claudebox", logId], {
              stdio: ["pipe", "inherit", "inherit"],
              env: { ...process.env, DUP: "1", PARENT_LOG_ID: parentLogId },
            });
            cacheLogProc.stdin?.write(headerLines.join("\n"));
          }

          // Start unified session streamer (replaces stream-session.ts + transcript poller)
          streamer = new SessionStreamer({
            projectDir: claudeProjectsDir,
            activityLog,
            repoDir: REPO_DIR,
            parentLogId: logId,
            onOutput: (text) => { cacheLogProc?.stdin?.write(text); },
          });
          streamer.start().catch(() => {});
        } catch (e) {
          console.warn(`[DOCKER] session streamer setup failed: ${e}`);
        }

        container.stdout?.on("data", (d: Buffer) => {
          const s = d.toString();
          process.stdout.write(s);
          onOutput?.(s);
          cacheLogProc?.stdin?.write(s);
        });
        container.stderr?.on("data", (d: Buffer) => {
          const s = d.toString();
          process.stderr.write(s);
          onOutput?.(s);
          cacheLogProc?.stdin?.write(s);
        });

        container.on("close", (code) => {
          decrActiveSessions();
          const exitCode = code ?? 1;
          console.log(`[DOCKER] Claude container ${claudeName} exited: ${exitCode}`);

          // Stop streamer and close cache_log
          if (streamer) {
            streamer.stop();
            setTimeout(() => { cacheLogProc?.stdin?.end(); }, 500);
          } else {
            setTimeout(() => { cacheLogProc?.stdin?.end(); }, 500);
          }

          cleanup();

          // Update metadata
          store.update(logId, {
            status: "completed",
            finished: new Date().toISOString(),
            exit_code: exitCode,
          });

          // Record activity line count so status page doesn't replay old entries on resume
          try {
            const actLines = store.readActivity(worktreeId).length;
            const metaPath = join(store.worktreesDir, worktreeId, "meta.json");
            const m = store.getWorktreeMeta(worktreeId);
            m.activity_synced_lines = actLines;
            writeFileSync(metaPath, JSON.stringify(m, null, 2));
          } catch {}

          // Update GitHub PR comment on completion
          updateGithubOnCompletion(store, logId, worktreeId, exitCode)
            .catch((e) => console.warn(`[DOCKER] GitHub completion update failed: ${e.message}`));

          resolve(exitCode);
        });
      });
    } catch (e: any) {
      decrActiveSessions();
      console.error(`[DOCKER] Session ${logId} failed: ${e.message}`);
      cleanup();
      store.update(logId, { status: "error", error: e.message, finished: new Date().toISOString() });
      return 1;
    }
  }

  // Set of logIds being monitored by recoverRunningSessions — prevents reconcile
  // from interfering with sessions we've already re-attached to.
  private recoveredSessions = new Set<string>();

  /** Check if a session is being monitored by recovery (for reconcile to skip). */
  isRecovered(logId: string): boolean {
    return this.recoveredSessions.has(logId);
  }

  /**
   * Recover sessions that are still running in Docker after a server restart.
   * Re-attaches session streamers and exit monitors for orphaned containers.
   */
  async recoverRunningSessions(store: WorktreeStore): Promise<void> {
    const all = store.listAll();
    const running = all.filter(s => s.status === "running" && s.container);

    if (!running.length) {
      console.log("[RECOVER] No running sessions to recover.");
      return;
    }

    console.log(`[RECOVER] Found ${running.length} session(s) marked running — checking containers...`);

    for (const session of running) {
      const logId = session._log_id!;
      const containerName = session.container!;
      const worktreeId = session.worktree_id;

      try {
        // Check if the Docker container is actually still running
        const { running: isRunning, exitCode } = this.inspectContainerSync(containerName);

        if (!isRunning) {
          // Container already exited — just update the session status
          const sidecarName = session.sidecar || `claudebox-sidecar-${logId}`;
          const networkName = `claudebox-net-${logId}`;
          this.forceRemoveSync(containerName);
          this.forceRemoveSync(sidecarName);
          this.removeNetworkSync(networkName);
          store.update(logId, {
            status: "completed",
            exit_code: exitCode,
            finished: new Date().toISOString(),
          });
          console.log(`[RECOVER] ${logId}: container already exited (code=${exitCode}) — marked completed`);
          continue;
        }

        // Container is still running — re-attach!
        console.log(`[RECOVER] ${logId}: container ${containerName} still running — re-attaching...`);
        incrActiveSessions();
        this.recoveredSessions.add(logId);

        // Shared exit handler — used by both with-worktree and without-worktree paths
        const onContainerExit = (code: number, streamer?: SessionStreamer, cacheLogProc?: ChildProcess | null) => {
          this.recoveredSessions.delete(logId);
          decrActiveSessions();
          console.log(`[RECOVER] Container ${containerName} exited: ${code}`);

          // Stop streamer and cache_log
          if (streamer) streamer.stop();
          if (cacheLogProc) setTimeout(() => { cacheLogProc.stdin?.end(); }, 500);

          // Clean up containers/network
          const sidecarName = session.sidecar || `claudebox-sidecar-${logId}`;
          const networkName = `claudebox-net-${logId}`;
          this.forceRemoveSync(containerName);
          this.stopAndRemoveSync(sidecarName, 5);
          this.removeNetworkSync(networkName);

          // Only update status if not already cancelled (e.g. by cancelSession)
          const current = store.get(logId);
          if (current && current.status === "running") {
            store.update(logId, {
              status: "completed",
              finished: new Date().toISOString(),
              exit_code: code,
            });
          }

          // Record activity line count
          if (worktreeId) {
            try {
              const actLines = store.readActivity(worktreeId).length;
              const metaPath = join(store.worktreesDir, worktreeId, "meta.json");
              const m = store.getWorktreeMeta(worktreeId);
              m.activity_synced_lines = actLines;
              writeFileSync(metaPath, JSON.stringify(m, null, 2));
            } catch {}

            // Update GitHub PR comment on completion
            updateGithubOnCompletion(store, logId, worktreeId, code)
              .catch((e) => console.warn(`[RECOVER] GitHub completion update failed: ${e.message}`));
          }
        };

        // Set up streamer + exit monitor
        let streamer: SessionStreamer | undefined;
        let cacheLogProc: ChildProcess | null = null;

        if (worktreeId) {
          try {
            const workspaceDir = join(store.worktreesDir, worktreeId, "workspace");
            const claudeProjectsDir = join(store.worktreesDir, worktreeId, "claude-projects");
            const activityLog = join(workspaceDir, "activity.jsonl");

            // Start cache_log if available
            const cacheLogBin = join(REPO_DIR, "ci3", "cache_log");
            if (existsSync(cacheLogBin)) {
              cacheLogProc = spawn(cacheLogBin, ["claudebox", logId], {
                stdio: ["pipe", "inherit", "inherit"],
                env: { ...process.env, DUP: "1" },
              });
            }

            streamer = new SessionStreamer({
              projectDir: claudeProjectsDir,
              activityLog,
              repoDir: REPO_DIR,
              parentLogId: logId,
              onOutput: (text) => { cacheLogProc?.stdin?.write(text); },
            });
            streamer.start().catch(() => {});
          } catch (e: any) {
            console.warn(`[RECOVER] ${logId}: failed to start streamer: ${e.message}`);
          }
        }

        // Spawn `docker wait` to monitor container exit
        // Works even if container already exited between inspect and now — returns immediately
        const capturedStreamer = streamer;
        const capturedCacheLog = cacheLogProc;
        let exited = false;
        const waiter = spawn("docker", ["wait", containerName], {
          stdio: ["ignore", "pipe", "ignore"],
        });

        // Accumulate stdout (docker wait may deliver exit code in chunks)
        // and parse on close to avoid double-firing onContainerExit
        let waiterBuf = "";
        waiter.stdout?.on("data", (d: Buffer) => { waiterBuf += d.toString(); });
        waiter.on("close", () => {
          if (exited) return;
          exited = true;
          const code = parseInt(waiterBuf.trim(), 10) || 1;
          onContainerExit(code, capturedStreamer, capturedCacheLog);
        });

        waiter.on("error", () => {
          if (exited) return;
          exited = true;
          onContainerExit(1, capturedStreamer, capturedCacheLog);
        });

        console.log(`[RECOVER] ${logId}: re-attached streamer + exit monitor`);
      } catch (e: any) {
        console.warn(`[RECOVER] ${logId}: error during recovery: ${e.message}`);
      }
    }
  }

  /** Cancel a running session by stopping its containers. */
  cancelSession(id: string, session: RunMeta, store: WorktreeStore): boolean {
    const logId = session._log_id || id;
    let cancelled = false;

    if (session.status === "running" && session.container) {
      this.stopAndRemoveSync(session.container, 5);
      const sidecarName = session.sidecar || `claudebox-sidecar-${logId}`;
      const networkName = `claudebox-net-${logId}`;
      this.stopAndRemoveSync(sidecarName, 3);
      this.removeNetworkSync(networkName);
      cancelled = true;
    }

    if (session.status === "running") {
      store.update(logId, { status: "cancelled", finished: new Date().toISOString() });
      cancelled = true;
    }

    if (cancelled) console.log(`[CANCEL] Session ${logId} cancelled`);
    return cancelled;
  }
}
