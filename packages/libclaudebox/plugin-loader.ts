/**
 * Plugin discovery and loading.
 *
 * Scans multiple directories for profiles:
 *   1. Repo profiles/ (set via setPluginsDir)
 *   2. User profile dirs (from ~/.claude/claudebox/settings.json profileDirs)
 *
 * Each profile directory contains:
 *   - plugin.ts (new-style) — exports a Plugin object
 *   - host-manifest.ts (legacy) — wrapped in a compatibility shim
 *   - mcp-sidecar.ts — MCP tool server (runs inside container)
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import type { Plugin } from "./plugin.ts";
import type { ProfileManifest } from "./profile-types.ts";
import { loadUserSettings } from "./settings.ts";

let _profilesDir = "";

export function setPluginsDir(dir: string): void {
  _profilesDir = dir;
}

export function getPluginsDir(): string {
  return _profilesDir;
}

/** Get all profile directories to scan (repo + user settings). */
function getAllProfileDirs(): string[] {
  const dirs: string[] = [];
  if (_profilesDir && existsSync(_profilesDir)) dirs.push(_profilesDir);
  const settings = loadUserSettings();
  for (const d of settings.profileDirs || []) {
    if (existsSync(d)) dirs.push(d);
  }
  return dirs;
}

/** Check if a directory looks like a profile (has plugin.ts, host-manifest.ts, or mcp-sidecar.ts). */
function isProfileDir(dir: string, name: string): boolean {
  return (
    existsSync(join(dir, name, "plugin.ts")) ||
    existsSync(join(dir, name, "host-manifest.ts")) ||
    existsSync(join(dir, name, "mcp-sidecar.ts"))
  );
}

/** Discover plugin/profile names by scanning all profile directories. */
export function discoverPlugins(): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const dir of getAllProfileDirs()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      if (isProfileDir(dir, entry.name)) {
        seen.add(entry.name);
        names.push(entry.name);
      }
    }
  }
  console.log(`[PLUGINS] Discovered: ${names.join(", ") || "(none)"}`);
  return names;
}

/** Resolve the filesystem path for a named profile across all dirs. */
function resolveProfileDir(name: string): string | null {
  for (const dir of getAllProfileDirs()) {
    if (existsSync(join(dir, name)) && isProfileDir(dir, name)) {
      return join(dir, name);
    }
  }
  return null;
}

/** Load a plugin by name. Searches all profile directories. */
export async function loadPlugin(name: string): Promise<Plugin> {
  const profileDir = resolveProfileDir(name);
  if (!profileDir) {
    return { name, setup() {} };
  }

  const pluginPath = join(profileDir, "plugin.ts");
  const manifestPath = join(profileDir, "host-manifest.ts");

  // New-style plugin
  if (existsSync(pluginPath)) {
    try {
      const mod = await import(`file://${pluginPath}`);
      const plugin: Plugin = mod.default;
      if (!plugin.name) plugin.name = name;
      return plugin;
    } catch (e: any) {
      console.error(`[PLUGINS] Failed to load plugin ${name}: ${e.message}`);
    }
  }

  // Legacy manifest → shim
  if (existsSync(manifestPath)) {
    try {
      const mod = await import(`file://${manifestPath}`);
      const manifest: ProfileManifest = mod.default;
      return manifestToPlugin(manifest);
    } catch (e: any) {
      console.error(`[PLUGINS] Failed to load manifest ${name}: ${e.message}`);
    }
  }

  // Bare minimum fallback
  return { name, setup() {} };
}

/** Wrap a legacy ProfileManifest as a Plugin (no-op setup, just config). */
function manifestToPlugin(manifest: ProfileManifest): Plugin {
  return {
    name: manifest.name,
    docker: manifest.docker,
    schemas: manifest.schemas,
    channels: manifest.channels,
    branchOverrides: manifest.branchOverrides,
    requiresServer: manifest.requiresServer,
    setup() {
      // Legacy manifests don't register handlers — server.ts handles dispatch
    },
  };
}

/** Load all plugins, optionally filtering to a specific set. */
export async function loadAllPlugins(only?: string[]): Promise<Plugin[]> {
  const names = only || discoverPlugins();
  const plugins: Plugin[] = [];
  for (const name of names) {
    plugins.push(await loadPlugin(name));
  }
  return plugins;
}
