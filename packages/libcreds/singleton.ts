/**
 * Lazy singleton for Creds instances.
 *
 * Most container code just needs `getCreds()` — it auto-detects everything
 * from environment variables. Profiles that need to set repo before init
 * can use `initCreds(opts)` instead.
 */

import { createCreds, type Creds, type CreateCredsOpts } from "./index.ts";

let _instance: Creds | null = null;

/**
 * Get the Creds singleton. Creates on first call via createCreds().
 * Subsequent calls return the same instance.
 */
export function getCreds(): Creds {
  if (!_instance) {
    _instance = createCreds();
  }
  return _instance;
}

/**
 * Explicitly initialize the Creds singleton with options.
 * Use this when the profile needs to set repo or other context before init.
 * Throws if already initialized.
 */
export function initCreds(opts: CreateCredsOpts): Creds {
  if (_instance) {
    throw new Error("[libcreds] Creds already initialized — call initCreds() before getCreds()");
  }
  _instance = createCreds(opts);
  return _instance;
}
