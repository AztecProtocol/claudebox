/**
 * User settings — ~/.claude/claudebox/settings.json
 *
 * Provides user-level configuration that merges with defaults.
 * Users can override the Docker image, add extra profile directories,
 * set a default profile, etc.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface UserSettings {
  /** Docker image override (default: "devbox:latest") */
  image?: string;
  /** Default profile name when none specified */
  defaultProfile?: string;
  /** Extra directories to scan for profiles (in addition to repo profiles/) */
  profileDirs?: string[];
  /** Container user (default: "claude") */
  containerUser?: string;
  /** Server URL for CLI commands */
  server?: string;
  /** API token for server */
  token?: string;
}

const SETTINGS_PATH = join(homedir(), ".claude", "claudebox", "settings.json");

let _cached: UserSettings | null = null;

export function loadUserSettings(): UserSettings {
  if (_cached) return _cached;
  try {
    if (existsSync(SETTINGS_PATH)) {
      _cached = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      return _cached!;
    }
  } catch {}
  _cached = {};
  return _cached;
}

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}
