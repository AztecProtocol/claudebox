import { readdirSync, existsSync } from "fs";
import { join } from "path";
import type { ProfileManifest, DockerConfig, RouteRegistration } from "./profile-types.ts";

let _profilesDir = "";
const _loaded = new Map<string, ProfileManifest>();
let _discovered: string[] | null = null;

/** Set the profiles directory. Call once at startup. */
export function setProfilesDir(dir: string): void {
  _profilesDir = dir;
  _discovered = null;
  _loaded.clear();
}

/** Scan profiles directory. Returns profile names. */
export function discoverProfiles(): string[] {
  if (_discovered) return _discovered;
  if (!_profilesDir || !existsSync(_profilesDir)) return [];
  _discovered = [];
  for (const entry of readdirSync(_profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // A profile needs at least mcp-sidecar.ts
    if (existsSync(join(_profilesDir, entry.name, "mcp-sidecar.ts"))) {
      _discovered.push(entry.name);
    }
  }
  console.log(`[PROFILES] Discovered: ${_discovered.join(", ") || "(none)"}`);
  return _discovered;
}

/** Lazily import and cache a profile's host manifest. */
export async function loadProfile(name: string): Promise<ProfileManifest> {
  const cached = _loaded.get(name);
  if (cached) return cached;

  const manifestPath = join(_profilesDir, name, "host-manifest.ts");
  if (!existsSync(manifestPath)) {
    const fallback: ProfileManifest = { name };
    _loaded.set(name, fallback);
    return fallback;
  }

  try {
    const mod = await import(manifestPath);
    const manifest: ProfileManifest = mod.default;
    _loaded.set(name, manifest);
    return manifest;
  } catch (e: any) {
    console.error(`[PROFILES] Failed to load ${name}: ${e.message}`);
    const fallback: ProfileManifest = { name };
    _loaded.set(name, fallback);
    return fallback;
  }
}

/** Get Docker config for a profile. */
export async function getDockerConfig(profileName: string): Promise<DockerConfig> {
  const manifest = await loadProfile(profileName);
  return manifest.docker ?? {};
}

/** Build channel→profile map from all discovered profiles. */
export async function buildChannelProfileMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of discoverProfiles()) {
    const manifest = await loadProfile(name);
    for (const ch of manifest.channels || []) map.set(ch, name);
  }
  return map;
}

/** Build channel→baseBranch map from all discovered profiles. */
export async function buildChannelBranchMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of discoverProfiles()) {
    const manifest = await loadProfile(name);
    for (const [ch, br] of Object.entries(manifest.branchOverrides || {})) map.set(ch, br);
  }
  return map;
}

/** Collect server routes from all discovered profiles, prefixed with /api/profiles/<name>/. */
export async function collectProfileRoutes(onlyProfiles?: string[]): Promise<RouteRegistration[]> {
  const all: RouteRegistration[] = [];
  const names = onlyProfiles || discoverProfiles();
  for (const name of names) {
    const manifest = await loadProfile(name);
    const routesFn = manifest.server?.routes;
    if (routesFn) {
      try {
        const routes = routesFn();
        // Mount each route under /api/profiles/<name>/
        for (const route of routes) {
          all.push({
            ...route,
            pattern: new RegExp(`^/api/profiles/${name}${route.pattern.source.replace(/^\^/, "/")}$`),
          });
        }
      } catch (e: any) {
        console.error(`[PROFILES] Failed to load routes for ${name}: ${e.message}`);
      }
    }
  }
  return all;
}
