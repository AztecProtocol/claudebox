/**
 * Plugin discovery and loading.
 *
 * Scans the repo profiles/ directory (set via setPluginsDir) for profiles.
 *
 * Each profile directory contains:
 *   - plugin.ts — exports a Plugin object
 *   - mcp-sidecar.ts — MCP tool server (runs inside container)
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import type { Plugin } from "./plugin.ts";

let _profilesDir = "";

export function setPluginsDir(dir: string): void {
  _profilesDir = dir;
}

export function getPluginsDir(): string {
  return _profilesDir;
}

/** Check if a directory looks like a profile (has plugin.ts or mcp-sidecar.ts). */
function isProfileDir(dir: string, name: string): boolean {
  return (
    existsSync(join(dir, name, "plugin.ts")) ||
    existsSync(join(dir, name, "mcp-sidecar.ts"))
  );
}

/** Discover plugin/profile names by scanning the profiles directory. */
export function discoverPlugins(): string[] {
  if (!_profilesDir || !existsSync(_profilesDir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(_profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (isProfileDir(_profilesDir, entry.name)) {
      names.push(entry.name);
    }
  }
  console.log(`[PLUGINS] Discovered: ${names.join(", ") || "(none)"}`);
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

/** Load a plugin by name. Searches all profile directories. */
export async function loadPlugin(name: string): Promise<Plugin> {
  const profileDir = resolveProfileDir(name);
  if (!profileDir) {
    return { name, setup() {} };
  }

  const pluginPath = join(profileDir, "plugin.ts");
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

  // Bare minimum fallback (directory has mcp-sidecar.ts but no plugin.ts)
  return { name, setup() {} };
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

// ── Convenience functions ────────────────────────────────────────

/** Get Docker config for a profile/plugin by name. */
export async function getDockerConfig(name: string): Promise<import("./plugin.ts").DockerConfig> {
  const plugin = await loadPlugin(name);
  return plugin.docker ?? {};
}

/** Build channel→profile map from all discovered plugins. */
export async function buildChannelProfileMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of discoverPlugins()) {
    const plugin = await loadPlugin(name);
    for (const ch of plugin.channels || []) map.set(ch, name);
  }
  return map;
}

/** Get summaryPrompt for a profile (queued after session completes). */
export async function getSummaryPrompt(name: string): Promise<string> {
  const plugin = await loadPlugin(name);
  return plugin.summaryPrompt || "";
}

/** Get promptSuffix for a profile (appended to every session prompt). */
export async function getPromptSuffix(name: string): Promise<string> {
  const plugin = await loadPlugin(name);
  return plugin.promptSuffix || "";
}

/** Build channel→branch map from all discovered plugins. */
export async function buildChannelBranchMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of discoverPlugins()) {
    const plugin = await loadPlugin(name);
    for (const [ch, br] of Object.entries(plugin.branchOverrides || {})) map.set(ch, br);
  }
  return map;
}
