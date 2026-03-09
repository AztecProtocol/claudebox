/**
 * Audit logger — writes credential access events to session JSONL files.
 *
 * NEVER logs sensitive data (tokens, secrets, credentials).
 * Fire-and-forget writes — audit failures don't block operations.
 */

import { appendFile } from "fs/promises";
import { appendFileSync } from "fs";
import type { AuditEntry, ServiceName, AccessLevel } from "./types.ts";

let _logPath: string | null = null;
let _sessionId = "";
let _logId = "";
let _profile = "";

export function initAuditLog(opts: { logPath: string; sessionId: string; logId?: string; profile: string }): void {
  _logPath = opts.logPath;
  _sessionId = opts.sessionId;
  _logId = opts.logId || "";
  _profile = opts.profile;
}

/** Log a credential access event. Fire-and-forget. For denials, use deny() instead. */
export function audit(
  service: ServiceName,
  level: AccessLevel,
  detail: string,
  allowed: boolean,
  reason?: string,
): void {
  if (!_logPath) return;

  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    service, level, detail, allowed,
    ...(reason ? { reason } : {}),
    profile: _profile,
    sessionId: _sessionId,
    ...((_logId ? { logId: _logId } : {})),
  };

  appendFile(_logPath, JSON.stringify(entry) + "\n").catch(() => {});
}

/** Deny an operation — logs synchronously, prints to stderr, throws. */
export function deny(service: ServiceName, level: AccessLevel, detail: string, reason: string): never {
  console.error(`[libcreds] BLOCKED ${service} — ${reason} (${detail})`);
  if (_logPath) {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      service, level, detail, allowed: false, reason,
      profile: _profile, sessionId: _sessionId,
      ...((_logId ? { logId: _logId } : {})),
    };
    try { appendFileSync(_logPath, JSON.stringify(entry) + "\n"); } catch {}
  }
  throw new Error(`[libcreds] Denied: ${reason}`);
}
