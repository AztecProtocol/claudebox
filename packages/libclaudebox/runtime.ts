/**
 * Mutable runtime state — populated at startup, mutated during operation.
 * Separated from config.ts (static env config) for clarity.
 */

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
export function getActiveSessions(): number { return _activeSessions; }
export function incrActiveSessions(): void { _activeSessions++; }
export function decrActiveSessions(): void { _activeSessions--; }
