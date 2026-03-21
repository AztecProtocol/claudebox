/**
 * Mutable runtime state — populated at startup, mutated during operation.
 * Separated from config.ts (static env config) for clarity.
 */

import type { ProfileRuntime } from "./profile.ts";
import type { CronStore } from "./cron-store.ts";
import { MAX_CONCURRENT, MAX_GLOBAL_SESSIONS } from "./config.ts";

// ── Channel maps (set once at startup by profile loader) ─────────
let _channelBranches: Record<string, string> = {};
let _channelProfiles: Record<string, string> = {};

export function setChannelMaps(branches: Record<string, string>, profiles: Record<string, string>): void {
  _channelBranches = branches;
  _channelProfiles = profiles;
}
export function getChannelBranches(): Record<string, string> { return _channelBranches; }
export function getChannelProfiles(): Record<string, string> { return _channelProfiles; }

// ── Active session counter ───────────────────────────────────────
let _activeSessions = 0;
const _profileSessions: Record<string, number> = {};

export function getActiveSessions(): number { return _activeSessions; }
export function getActiveSessionsForProfile(profile: string): number { return _profileSessions[profile] || 0; }

export function incrActiveSessions(profile?: string): void {
  _activeSessions++;
  if (profile) _profileSessions[profile] = (_profileSessions[profile] || 0) + 1;
}
export function decrActiveSessions(profile?: string): void {
  _activeSessions--;
  if (profile && _profileSessions[profile]) _profileSessions[profile]--;
}

// ── Singleton references (set at startup) ───────────────────────
let _profileRuntime: ProfileRuntime | undefined;
let _cronStore: CronStore | undefined;
export function setProfileRuntime(pr: ProfileRuntime): void { _profileRuntime = pr; }
export function getProfileRuntime(): ProfileRuntime | undefined { return _profileRuntime; }

export function setCronStore(cs: CronStore): void { _cronStore = cs; }
export function getCronStore(): CronStore | undefined { return _cronStore; }

/** Check if a profile has capacity for another session. */
export function hasCapacity(profile?: string): boolean {
  // Hard global ceiling — always enforced regardless of per-profile settings
  if (_activeSessions >= MAX_GLOBAL_SESSIONS) return false;
  if (!profile || !_profileRuntime) {
    return _activeSessions < MAX_CONCURRENT;
  }
  const max = _profileRuntime.getMaxConcurrent(profile);
  return getActiveSessionsForProfile(profile) < max;
}

/** Get the effective max concurrent for a profile. */
export function getEffectiveMaxConcurrent(profile?: string): number {
  if (!profile || !_profileRuntime) return MAX_CONCURRENT;
  return _profileRuntime.getMaxConcurrent(profile);
}
