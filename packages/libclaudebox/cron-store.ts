/**
 * CronStore — persistent cron job storage and scheduler.
 *
 * Crons are channel-scoped. Profile is derived at runtime from channel→profile mapping.
 * Storage: ~/.claudebox/crons/<id>.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { CronExpressionParser } from "cron-parser";
import type { WorktreeStore } from "./worktree-store.ts";
import type { DockerService } from "./docker.ts";
import { getChannelProfiles, hasCapacity } from "./runtime.ts";

export interface CronJob {
  id: string;
  channel_id: string;
  name: string;
  schedule: string;
  prompt: string;
  user: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastWorktreeId?: string;
}

export class CronStore {
  private dir: string;
  private jobs = new Map<string, CronJob>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.loadAll();
  }

  private loadAll(): void {
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.dir, file), "utf-8"));
        this.jobs.set(data.id, data);
      } catch (e: any) {
        console.warn(`[CRON] Failed to load ${file}: ${e.message}`);
      }
    }
    console.log(`[CRON] Loaded ${this.jobs.size} cron jobs`);
  }

  private persist(job: CronJob): void {
    writeFileSync(join(this.dir, `${job.id}.json`), JSON.stringify(job, null, 2));
  }

  create(opts: Omit<CronJob, "id" | "createdAt" | "updatedAt">): CronJob {
    // Validate cron expression
    CronExpressionParser.parse(opts.schedule);

    const job: CronJob = {
      ...opts,
      id: randomBytes(8).toString("hex"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    return job;
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  list(channelId?: string): CronJob[] {
    const all = [...this.jobs.values()];
    if (channelId) return all.filter(j => j.channel_id === channelId);
    return all;
  }

  listByProfile(profile: string): CronJob[] {
    const channelProfiles = getChannelProfiles();
    return [...this.jobs.values()].filter(j => {
      const jobProfile = channelProfiles[j.channel_id] || "default";
      return jobProfile === profile;
    });
  }

  update(id: string, patch: Partial<CronJob>): CronJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    // Validate schedule if being updated
    if (patch.schedule) CronExpressionParser.parse(patch.schedule);

    const updated = { ...job, ...patch, id: job.id, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    this.persist(updated);
    return updated;
  }

  delete(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.jobs.delete(id);
    const file = join(this.dir, `${id}.json`);
    if (existsSync(file)) unlinkSync(file);
    return true;
  }

  /**
   * Tick — called every 30s by server.ts. Evaluates enabled crons against current time.
   * Fires sessions for crons whose next occurrence falls within the current minute.
   */
  async tick(docker: DockerService, store: WorktreeStore): Promise<void> {
    const now = new Date();
    const channelProfiles = getChannelProfiles();

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;

      try {
        // Check if this cron should fire now
        const interval = CronExpressionParser.parse(job.schedule);
        const prev = interval.prev().toDate();
        const prevMinute = Math.floor(prev.getTime() / 60000);
        const nowMinute = Math.floor(now.getTime() / 60000);

        // Only fire if prev occurrence is this minute and we haven't already fired
        if (prevMinute !== nowMinute) continue;

        // Dedup: skip if we already ran in this minute
        if (job.lastRunAt) {
          const lastMinute = Math.floor(new Date(job.lastRunAt).getTime() / 60000);
          if (lastMinute === nowMinute) continue;
        }

        // Profile from channel mapping
        const profile = channelProfiles[job.channel_id] || "default";

        // Capacity check
        if (!hasCapacity(profile)) {
          console.log(`[CRON] ${job.name} (${job.id}): skipped — ${profile} at capacity`);
          continue;
        }

        console.log(`[CRON] Firing: ${job.name} (${job.id}) schedule=${job.schedule}`);

        // Start session
        const exitCode = docker.runContainerSession({
          prompt: job.prompt,
          userName: job.user || "cron",
          profile,
          slackChannel: job.channel_id,
          cronJobId: job.id,
        }, store);

        // Update last run (don't await the session — it runs in background)
        this.update(job.id, { lastRunAt: now.toISOString() });

      } catch (e: any) {
        console.error(`[CRON] Error evaluating ${job.name} (${job.id}): ${e.message}`);
      }
    }
  }
}
