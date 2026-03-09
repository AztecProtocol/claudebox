/**
 * Profile discovery and loading.
 *
 * Scans the repo profiles/ directory (set via setProfilesDir) for profiles.
 *
 * Each profile directory contains:
 *   - plugin.ts — exports a Profile object
 *   - mcp-sidecar.ts — MCP tool server (runs inside container)
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import type { Profile } from "./profile.ts";

let _profilesDir = "";

export function setProfilesDir(dir: string): void {
  _profilesDir = dir;
}

export function getProfilesDir(): string {
  return _profilesDir;
}

/** Check if a directory looks like a profile (has plugin.ts or mcp-sidecar.ts). */
function isProfileDir(dir: string, name: string): boolean {
  return (
    existsSync(join(dir, name, "plugin.ts")) ||
    existsSync(join(dir, name, "mcp-sidecar.ts"))
  );
}

/** Discover profile names by scanning the profiles directory. */
export function discoverProfiles(): string[] {
  if (!_profilesDir || !existsSync(_profilesDir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(_profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (isProfileDir(_profilesDir, entry.name)) {
      names.push(entry.name);
    }
  }
  console.log(`[PROFILES] Discovered: ${names.join(", ") || "(none)"}`);
  return names;
}

/** Resolve the filesystem path for a named profile. */
function resolveProfileDir(name: string): string | null {
  if (!_profilesDir || !existsSync(_profilesDir)) return null;
  if (existsSync(join(_profilesDir, name)) && isProfileDir(_profilesDir, name)) {
    return join(_profilesDir, name);
  }
  return null;
}

/** Load a profile by name. Searches all profile directories. */
export async function loadProfile(name: string): Promise<Profile> {
  const profileDir = resolveProfileDir(name);
  if (!profileDir) {
    return { name, setup() {} };
  }

  const pluginPath = join(profileDir, "plugin.ts");
  if (existsSync(pluginPath)) {
    try {
      const mod = await import(`file://${pluginPath}`);
      const profile: Profile = mod.default;
      if (!profile.name) profile.name = name;
      return profile;
    } catch (e: any) {
      console.error(`[PROFILES] Failed to load profile ${name}: ${e.message}`);
    }
  }

  // Bare minimum fallback (directory has mcp-sidecar.ts but no plugin.ts)
  return { name, setup() {} };
}

/** Load all profiles, optionally filtering to a specific set. */
export async function loadAllProfiles(only?: string[]): Promise<Profile[]> {
  const names = only || discoverProfiles();
  const profiles: Profile[] = [];
  for (const name of names) {
    profiles.push(await loadProfile(name));
  }
  return profiles;
}

// ── Convenience functions ────────────────────────────────────────

/** Build channel→profile map from all discovered profiles. */
export async function buildChannelProfileMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of discoverProfiles()) {
    const profile = await loadProfile(name);
    for (const ch of profile.channels || []) map.set(ch, name);
  }
  return map;
}

/** Get summaryPrompt for a profile (queued after session completes). */
export async function getSummaryPrompt(name: string): Promise<string> {
  const profile = await loadProfile(name);
  return profile.summaryPrompt || "";
}

/** Get DockerConfig for a profile. */
export async function getDockerConfig(name: string): Promise<import("./profile.ts").DockerConfig> {
  const profile = await loadProfile(name);
  return profile.docker || {};
}

/** Get promptSuffix for a profile. */
export async function getPromptSuffix(name: string): Promise<string> {
  const profile = await loadProfile(name);
  return profile.promptSuffix || "";
}

/** Get tag categories for a profile. */
export async function getTagCategories(name: string): Promise<string[]> {
  const profile = await loadProfile(name);
  return profile.tagCategories || [];
}

/** Collect tag categories from all discovered profiles. */
export async function getAllTagCategories(): Promise<string[]> {
  const all = new Set<string>();
  for (const name of discoverProfiles()) {
    const profile = await loadProfile(name);
    for (const cat of profile.tagCategories || []) all.add(cat);
  }
  return [...all];
}

/** Build channel→branch map from all discovered profiles. */
export async function buildChannelBranchMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of discoverProfiles()) {
    const profile = await loadProfile(name);
    for (const [ch, br] of Object.entries(profile.branchOverrides || {})) map.set(ch, br);
  }
  return map;
}
