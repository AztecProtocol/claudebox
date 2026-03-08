/**
 * Mock DockerService — simulates container operations in-process.
 *
 * Instead of spawning real Docker containers, this mock:
 * - Runs the mock-claude script directly as a child process
 * - Tracks container lifecycle (create, start, stop, remove)
 * - Records all operations for test assertions
 */

import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import type { ContainerSessionOpts, SessionMeta } from "../../packages/libclaudebox/types.ts";
import type { SessionStore } from "../../packages/libclaudebox/session-store.ts";

export interface MockContainer {
  name: string;
  image: string;
  status: "created" | "running" | "stopped" | "removed";
  env: Record<string, string>;
  binds: string[];
  startedAt?: number;
  stoppedAt?: number;
}

export interface MockOperation {
  op: string;
  name: string;
  timestamp: number;
}

export class MockDockerService {
  containers = new Map<string, MockContainer>();
  networks = new Map<string, { name: string; created: boolean }>();
  operations: MockOperation[] = [];

  private record(op: string, name: string) {
    this.operations.push({ op, name, timestamp: Date.now() });
  }

  // ── Container operations ──

  inspectContainerSync(name: string): { running: boolean; exitCode: number } {
    const c = this.containers.get(name);
    if (!c) return { running: false, exitCode: 1 };
    return { running: c.status === "running", exitCode: 0 };
  }

  forceRemoveSync(name: string): void {
    this.record("forceRemove", name);
    this.containers.delete(name);
  }

  stopAndRemoveSync(name: string, _timeout = 5): void {
    this.record("stopAndRemove", name);
    const c = this.containers.get(name);
    if (c) { c.status = "stopped"; c.stoppedAt = Date.now(); }
    this.containers.delete(name);
  }

  removeNetworkSync(name: string): void {
    this.record("removeNetwork", name);
    this.networks.delete(name);
  }

  async createNetwork(name: string): Promise<void> {
    this.record("createNetwork", name);
    this.networks.set(name, { name, created: true });
  }

  async removeNetwork(name: string): Promise<void> {
    this.record("removeNetwork", name);
    this.networks.delete(name);
  }

  async stopAndRemove(name: string, _timeout = 5): Promise<void> {
    this.stopAndRemoveSync(name, _timeout);
  }

  async waitForHealth(_containerName: string, _timeoutMs = 15_000): Promise<void> {
    // Mock always healthy immediately
  }

  // ── Session runner (simplified) ──

  async runMockSession(
    opts: ContainerSessionOpts,
    store: SessionStore,
    mockClaudePath: string,
  ): Promise<number> {
    const wt = store.getOrCreateWorktree(opts.worktreeId);
    const logId = store.nextSessionLogId(wt.worktreeId);

    store.save(logId, {
      prompt: opts.prompt,
      user: opts.userName || "test",
      log_url: `http://mock/${logId}`,
      worktree_id: wt.worktreeId,
      status: "running",
      started: new Date().toISOString(),
      profile: opts.profile || "",
    });

    // Run mock-claude as a subprocess
    return new Promise<number>((resolve) => {
      const proc = spawn("node", [
        "--experimental-strip-types", "--no-warnings",
        mockClaudePath,
      ], {
        env: {
          ...process.env,
          CLAUDEBOX_PROJECTS_DIR: wt.claudeProjectsDir,
          CLAUDEBOX_WORKSPACE: wt.workspaceDir,
          CLAUDEBOX_PROMPT: opts.prompt,
          MOCK_DELAY_MS: "10",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
      proc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

      proc.on("close", (code) => {
        const exitCode = code ?? 1;
        store.update(logId, {
          status: "completed",
          finished: new Date().toISOString(),
          exit_code: exitCode,
        });
        resolve(exitCode);
      });
    });
  }

  // ── Test helpers ──

  getOperations(op?: string): MockOperation[] {
    return op ? this.operations.filter(o => o.op === op) : this.operations;
  }

  reset(): void {
    this.containers.clear();
    this.networks.clear();
    this.operations = [];
  }
}
