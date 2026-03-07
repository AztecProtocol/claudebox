/**
 * Credential management for ClaudeBox.
 *
 * Supports multiple API keys with usage-based rotation.
 * Used by `claudebox init` and `claudebox init --add-credentials`.
 *
 * Storage: ~/.claude/claudebox/credentials.json
 *
 * Rotation strategy: round-robin through keys, tracking usage per key.
 * When a key's usage exceeds its budget, rotate to the next one.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface ApiKeyEntry {
  key: string;
  label?: string;       // e.g. "personal", "work", "team-shared"
  addedAt: string;
  /** Cumulative usage in USD (updated by the session tracker). */
  usageDollars: number;
  /** Monthly budget in USD. 0 = unlimited. */
  budgetDollars: number;
  /** Whether this key is currently disabled (over budget, revoked, etc.) */
  disabled: boolean;
}

export interface StoredCredentials {
  /** Primary key (for backwards compat; first entry in keys array) */
  anthropicApiKey?: string;
  /** All configured keys for rotation */
  keys: ApiKeyEntry[];
  /** Index of the currently active key */
  activeKeyIndex: number;
  createdAt: string;
  updatedAt: string;
}

export class CredentialStore {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  load(): StoredCredentials | null {
    try {
      if (!existsSync(this.path)) return null;
      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      // Migrate old format (single key, no keys array)
      if (!raw.keys) {
        raw.keys = raw.anthropicApiKey
          ? [{ key: raw.anthropicApiKey, addedAt: raw.createdAt || new Date().toISOString(), usageDollars: 0, budgetDollars: 0, disabled: false }]
          : [];
        raw.activeKeyIndex = 0;
      }
      return raw;
    } catch {
      return null;
    }
  }

  private persist(creds: StoredCredentials): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  }

  /** Save a single API key (initial setup or overwrite). */
  save(input: { anthropicApiKey?: string }): void {
    const existing = this.load();
    const now = new Date().toISOString();

    const keys: ApiKeyEntry[] = [];
    if (input.anthropicApiKey) {
      keys.push({
        key: input.anthropicApiKey,
        addedAt: now,
        usageDollars: 0,
        budgetDollars: 0,
        disabled: false,
      });
    }

    const full: StoredCredentials = {
      anthropicApiKey: input.anthropicApiKey,
      keys,
      activeKeyIndex: 0,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.persist(full);
  }

  /** Add an additional API key for rotation. */
  addKey(key: string, opts?: { label?: string; budgetDollars?: number }): void {
    const creds = this.load() || {
      keys: [], activeKeyIndex: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    // Don't add duplicate keys
    if (creds.keys.some(k => k.key === key)) {
      throw new Error("This API key is already registered.");
    }

    creds.keys.push({
      key,
      label: opts?.label,
      addedAt: new Date().toISOString(),
      usageDollars: 0,
      budgetDollars: opts?.budgetDollars || 0,
      disabled: false,
    });
    creds.updatedAt = new Date().toISOString();
    // Set primary key if this is the first
    if (!creds.anthropicApiKey) creds.anthropicApiKey = key;
    this.persist(creds);
  }

  /** Remove an API key by index or key prefix. */
  removeKey(identifier: string): boolean {
    const creds = this.load();
    if (!creds) return false;

    const idx = parseInt(identifier, 10);
    let removeIdx = -1;

    if (!isNaN(idx) && idx >= 0 && idx < creds.keys.length) {
      removeIdx = idx;
    } else {
      removeIdx = creds.keys.findIndex(k => k.key.startsWith(identifier) || k.label === identifier);
    }

    if (removeIdx < 0) return false;

    creds.keys.splice(removeIdx, 1);
    if (creds.activeKeyIndex >= creds.keys.length) creds.activeKeyIndex = 0;
    creds.anthropicApiKey = creds.keys[0]?.key || undefined;
    creds.updatedAt = new Date().toISOString();
    this.persist(creds);
    return true;
  }

  /** Get the currently active API key, rotating if needed. */
  getApiKey(): string | null {
    const creds = this.load();
    if (!creds || creds.keys.length === 0) return creds?.anthropicApiKey || null;

    // Find the first non-disabled, under-budget key starting from activeKeyIndex
    const n = creds.keys.length;
    for (let i = 0; i < n; i++) {
      const idx = (creds.activeKeyIndex + i) % n;
      const entry = creds.keys[idx];
      if (entry.disabled) continue;
      if (entry.budgetDollars > 0 && entry.usageDollars >= entry.budgetDollars) continue;
      // If we rotated, persist the new index
      if (idx !== creds.activeKeyIndex) {
        creds.activeKeyIndex = idx;
        creds.updatedAt = new Date().toISOString();
        this.persist(creds);
      }
      return entry.key;
    }

    // All keys exhausted — return first key anyway (let Anthropic reject if over limit)
    return creds.keys[0]?.key || null;
  }

  /** Record usage against the active key. Called after a session completes. */
  recordUsage(apiKey: string, dollars: number): void {
    const creds = this.load();
    if (!creds) return;

    const entry = creds.keys.find(k => k.key === apiKey);
    if (entry) {
      entry.usageDollars += dollars;
      creds.updatedAt = new Date().toISOString();
      this.persist(creds);
    }
  }

  /** Get all keys with their usage stats. */
  listKeys(): ApiKeyEntry[] {
    return this.load()?.keys || [];
  }

  /** Build env vars to pass into containers. */
  containerEnvVars(): string[] {
    const key = this.getApiKey();
    if (key) return [`ANTHROPIC_API_KEY=${key}`];
    return [];
  }
}
