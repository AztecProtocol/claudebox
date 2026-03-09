/**
 * Audit logger — writes credential access events to session JSONL files.
 * Never logs sensitive data (tokens, secrets, credentials).
 * Fully async — fire-and-forget writes that don't block operations.
 */

import { appendFile } from "fs/promises";
import type { AuditEntry, ServiceName, DangerLevel } from "./types.ts";

let _logPath: string | null = null;
let _sessionId = "";
let _logId = "";

export function initAuditLog(opts: { logPath: string; sessionId: string; logId?: string }): void {
  _logPath = opts.logPath;
  _sessionId = opts.sessionId;
  _logId = opts.logId || "";
}

export async function logCredAccess(opts: {
  service: ServiceName;
  operation: string;
  danger: DangerLevel;
  detail: string;
  allowed: boolean;
  reason?: string;
}): Promise<void> {
  if (!_logPath) return;

  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    type: "cred_access",
    service: opts.service,
    operation: opts.operation,
    danger: opts.danger,
    detail: opts.detail,
    allowed: opts.allowed,
    reason: opts.reason,
    sessionId: _sessionId,
    logId: _logId,
  };

  try {
    await appendFile(_logPath, JSON.stringify(entry) + "\n");
  } catch {
    // Audit log write failure is non-fatal — don't break the operation
  }
}

/**
 * Log a blocked operation — always logged even without an audit log path.
 * Prints to stderr so it appears in container logs.
 */
export async function logBlocked(service: ServiceName, operation: string, detail: string, reason: string): Promise<void> {
  console.error(`[libcreds] BLOCKED ${service}:${operation} — ${reason} (${detail})`);
  await logCredAccess({ service, operation, danger: "read", detail, allowed: false, reason });
}
