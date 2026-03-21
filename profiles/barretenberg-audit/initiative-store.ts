/**
 * InitiativeStore — manages audit initiatives for barretenberg-audit profile.
 *
 * An initiative groups sessions by tag, has a default prompt, and triggers
 * summary sessions every N completions.
 *
 * Storage: ~/.claudebox/initiatives/<id>.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { WorktreeStore } from "../../packages/libclaudebox/worktree-store.ts";
import type { DockerService } from "../../packages/libclaudebox/docker.ts";
import { CLAUDEBOX_INITIATIVES_DIR } from "../../packages/libclaudebox/config.ts";

export interface Initiative {
  id: string;
  name: string;
  tag: string;
  defaultPrompt: string;
  summaryPrompt: string;
  summaryWorktreeId?: string;
  summaryGistUrls: string[];
  completedSinceLastSummary: number;
  summaryThreshold: number;  // default 10
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_SUMMARY_PROMPT = `You are a summarizer for an ongoing audit initiative. Review the last 20 session logs and produce a comprehensive progress summary gist. Include:
1. Sessions completed and their outcomes
2. Key findings across sessions
3. Coverage progress
4. Recommendations for next steps
5. Any blockers or patterns observed

Create a gist with your summary and respond with the gist URL.`;

export class InitiativeStore {
  private dir: string;
  private initiatives = new Map<string, Initiative>();

  constructor(dir?: string) {
    this.dir = dir || CLAUDEBOX_INITIATIVES_DIR;
    mkdirSync(this.dir, { recursive: true });
    this.loadAll();
  }

  private loadAll(): void {
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.dir, file), "utf-8"));
        this.initiatives.set(data.id, data);
      } catch (e: any) {
        console.warn(`[INITIATIVE] Failed to load ${file}: ${e.message}`);
      }
    }
    console.log(`[INITIATIVE] Loaded ${this.initiatives.size} initiatives`);
  }

  private persist(init: Initiative): void {
    writeFileSync(join(this.dir, `${init.id}.json`), JSON.stringify(init, null, 2));
  }

  create(opts: {
    name: string;
    tag: string;
    defaultPrompt: string;
    summaryPrompt?: string;
    summaryThreshold?: number;
  }): Initiative {
    // Check for duplicate tag
    for (const existing of this.initiatives.values()) {
      if (existing.tag === opts.tag) throw new Error(`Tag "${opts.tag}" is already used by initiative "${existing.name}"`);
    }

    const init: Initiative = {
      id: randomBytes(8).toString("hex"),
      name: opts.name,
      tag: opts.tag,
      defaultPrompt: opts.defaultPrompt,
      summaryPrompt: opts.summaryPrompt || DEFAULT_SUMMARY_PROMPT,
      summaryGistUrls: [],
      completedSinceLastSummary: 0,
      summaryThreshold: opts.summaryThreshold || 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.initiatives.set(init.id, init);
    this.persist(init);
    return init;
  }

  get(id: string): Initiative | undefined {
    return this.initiatives.get(id);
  }

  getByTag(tag: string): Initiative | undefined {
    for (const init of this.initiatives.values()) {
      if (init.tag === tag) return init;
    }
    return undefined;
  }

  list(): Initiative[] {
    return [...this.initiatives.values()];
  }

  update(id: string, patch: Partial<Initiative>): Initiative | null {
    const init = this.initiatives.get(id);
    if (!init) return null;
    const updated = { ...init, ...patch, id: init.id, updatedAt: new Date().toISOString() };
    this.initiatives.set(id, updated);
    this.persist(updated);
    return updated;
  }

  delete(id: string): boolean {
    const init = this.initiatives.get(id);
    if (!init) return false;
    this.initiatives.delete(id);
    const file = join(this.dir, `${id}.json`);
    if (existsSync(file)) unlinkSync(file);
    return true;
  }

  /**
   * Called when a session with a matching tag completes.
   * Increments counter, triggers summary at threshold.
   */
  async onSessionComplete(
    tag: string,
    store: WorktreeStore,
    docker: DockerService,
    profile: string,
  ): Promise<void> {
    const init = this.getByTag(tag);
    if (!init) return;

    const count = init.completedSinceLastSummary + 1;
    if (count >= init.summaryThreshold) {
      console.log(`[INITIATIVE] ${init.name}: ${count} completions — triggering summary`);
      this.update(init.id, { completedSinceLastSummary: 0 });
      await this.triggerSummary(init, store, docker, profile);
    } else {
      this.update(init.id, { completedSinceLastSummary: count });
    }
  }

  /**
   * Trigger a summary session for an initiative.
   * Uses a persistent worktree for continuity.
   */
  private async triggerSummary(
    init: Initiative,
    store: WorktreeStore,
    docker: DockerService,
    profile: string,
  ): Promise<void> {
    // Build context for summary prompt
    const recentSessions = store.listAll()
      .filter(s => s.profile === profile && s.tags?.includes(init.tag))
      .slice(0, 20);

    const sessionContext = recentSessions.map(s =>
      `- ${s._log_id}: ${s.status} (exit ${s.exit_code || "?"}) — ${(s.prompt || "").slice(0, 100)}`
    ).join("\n");

    const pastGists = init.summaryGistUrls.length
      ? `\n\nPast summary gists:\n${init.summaryGistUrls.map(u => `- ${u}`).join("\n")}`
      : "";

    const prompt = `${init.summaryPrompt}

Initiative: ${init.name} (tag: ${init.tag})

Recent sessions (last 20):
${sessionContext || "(none yet)"}
${pastGists}`;

    try {
      docker.runContainerSession({
        prompt,
        userName: "initiative-summary",
        profile,
        worktreeId: init.summaryWorktreeId || undefined,
      }, store, undefined, (_logUrl, worktreeId) => {
        // Store the worktree ID for future summaries
        if (!init.summaryWorktreeId) {
          this.update(init.id, { summaryWorktreeId: worktreeId });
        }
      });
    } catch (e: any) {
      console.error(`[INITIATIVE] Summary trigger failed for ${init.name}: ${e.message}`);
    }
  }

  /** Add a summary gist URL to an initiative. */
  addSummaryGist(id: string, gistUrl: string): void {
    const init = this.initiatives.get(id);
    if (!init) return;
    const urls = [...init.summaryGistUrls, gistUrl].slice(-20);
    this.update(id, { summaryGistUrls: urls });
  }
}
