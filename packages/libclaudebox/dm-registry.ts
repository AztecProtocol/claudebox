/**
 * DM Registry — maps Slack user IDs to personal ClaudeBox server URLs.
 *
 * When a registered user sends a DM to the bot, the message is proxied
 * to their personal server instead of being handled locally.
 *
 * Persistence: JSON file at <claudebox-dir>/dm-registry.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface DmRegistration {
  serverUrl: string;
  token?: string;       // Bearer token for the personal server
  registeredAt: string;
  label?: string;       // Human-readable label (e.g. "adam's laptop")
}

export class DmRegistry {
  private registryPath: string;
  private entries: Map<string, DmRegistration> = new Map();

  constructor(storagePath: string) {
    this.registryPath = storagePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.registryPath)) {
        const data = JSON.parse(readFileSync(this.registryPath, "utf-8"));
        this.entries = new Map(Object.entries(data));
      }
    } catch {
      this.entries = new Map();
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify(Object.fromEntries(this.entries), null, 2) + "\n");
  }

  register(userId: string, registration: DmRegistration): void {
    this.entries.set(userId, registration);
    this.persist();
  }

  unregister(userId: string): boolean {
    const had = this.entries.delete(userId);
    if (had) this.persist();
    return had;
  }

  lookup(userId: string): DmRegistration | undefined {
    return this.entries.get(userId);
  }

  list(): Map<string, DmRegistration> {
    return new Map(this.entries);
  }

  size(): number {
    return this.entries.size;
  }
}

/**
 * Proxy a DM to a user's personal ClaudeBox server.
 * Returns true if the proxy succeeded, false if it failed (caller should handle locally).
 */
export async function proxyDmToServer(
  registration: DmRegistration,
  message: {
    text: string;
    userId: string;
    userName: string;
    channel: string;
    threadTs?: string;
    isReply: boolean;
  },
): Promise<{ ok: boolean; error?: string }> {
  const url = `${registration.serverUrl.replace(/\/$/, "")}/run`;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (registration.token) headers["Authorization"] = `Bearer ${registration.token}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: message.text,
        user: message.userName,
        slack_user_id: message.userId,
        slack_channel: message.channel,
        slack_thread_ts: message.threadTs,
        source: "dm-proxy",
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Server returned ${res.status}: ${body.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message || "unknown error" };
  }
}
