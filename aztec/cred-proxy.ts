/**
 * Aztec CI Credential Proxy — proxies Redis, SSH, and disk transfer operations
 * for Claude containers that don't have direct access to credentials.
 *
 * SECURITY MODEL:
 * - Redis keys are passed as array arguments to execFileSync (no shell interpolation).
 * - Cache keys are validated as hex-only, then used in a shell command over SSH.
 *   The hex-only constraint makes injection impossible (no metacharacters).
 * - Pub/sub channels are validated the same way as Redis keys.
 * - All validators are functions that return typed results, not inline regex checks.
 */

import { execFileSync, execSync, spawn, type ChildProcess } from "child_process";
import type { IncomingMessage, ServerResponse } from "http";

const REDIS_HOST = "ci-redis-tiered.lzka0i.ng.0001.use2.cache.amazonaws.com";
const BASTION_HOST = "ci-bastion.aztecprotocol.com";
const SSH_KEY_PATH = "/home/claude/.ssh/build_instance_key";

// ── Key validators ──────────────────────────────────────────────
// Each returns null on success, or an error string on failure.
// Validators are strict and purpose-specific — no shared "looks ok" regex.

/** Redis keys: hex, colons, underscores, hyphens, dots, slashes. No `..` or leading `/`. */
function validateRedisKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return "missing key";
  if (key.length > 256) return "key too long";
  if (!/^[a-zA-Z0-9:._\/-]+$/.test(key)) return "invalid characters in key";
  if (key.includes("..")) return "path traversal in key";
  if (key.startsWith("/")) return "absolute path in key";
  return null;
}

/** Cache keys used in shell commands over SSH: hex + dots + hyphens ONLY. No slashes, no underscores even. */
function validateCacheKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return "missing key";
  if (key.length > 128) return "key too long";
  if (!/^[a-f0-9._-]+$/.test(key)) return "cache key must be hex/dot/hyphen only";
  return null;
}

/** Cache subfolder: alphanumeric + hyphens + underscores only. */
function validateSubfolder(subfolder: unknown): string | null {
  if (typeof subfolder !== "string") return "invalid subfolder type";
  if (subfolder.length > 64) return "subfolder too long";
  if (!/^[a-zA-Z0-9_-]+$/.test(subfolder)) return "subfolder must be alphanumeric/hyphen/underscore";
  return null;
}

/** Redis expire TTL in seconds. */
function validateExpire(expire: unknown): { seconds: number } | { error: string } {
  if (typeof expire !== "string" || expire.length === 0) return { error: "missing expire" };
  const n = parseInt(expire, 10);
  if (isNaN(n) || n <= 0 || n > 2592000) return { error: "expire must be 1-2592000" };
  return { seconds: n };
}

// ── Redis tunnel ────────────────────────────────────────────────

let _redisTunnel: ChildProcess | null = null;

function ensureRedisTunnel(): boolean {
  try { execSync("nc -z localhost 6379", { timeout: 2000, stdio: "ignore" }); return true; } catch {}
  if (_redisTunnel && !_redisTunnel.killed) {
    try { execSync("nc -z localhost 6379", { timeout: 5000, stdio: "ignore" }); return true; } catch {}
    return false;
  }
  try {
    _redisTunnel = spawn("ssh", [
      "-N", "-L", `6379:${REDIS_HOST}:6379`,
      "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/ssh_mux_%h_%p_%r", "-o", "ControlPersist=480m",
      "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
      "-i", SSH_KEY_PATH,
      `ubuntu@${BASTION_HOST}`,
    ], { stdio: "ignore", detached: true });
    _redisTunnel.unref();
    for (let i = 0; i < 10; i++) {
      try { execSync("nc -z localhost 6379", { timeout: 1000, stdio: "ignore" }); return true; } catch {}
      execSync("sleep 0.5", { stdio: "ignore" });
    }
    console.error("[Creds] Redis tunnel opened but port not reachable");
    return false;
  } catch (e: any) {
    console.error(`[Creds] Failed to open Redis tunnel: ${e.message}`);
    return false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function readRawBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error("Body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function badRequest(res: ServerResponse, error: string): void {
  res.writeHead(400); res.end(JSON.stringify({ error }));
}

// ── Request handler ─────────────────────────────────────────────

export async function handleCredentialRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url!.replace("/creds/", "");
  if (path !== "redis-getz" && req.method !== "POST") {
    res.writeHead(405); res.end('{"error":"method not allowed"}'); return;
  }

  try {
    if (path === "redis-setexz") {
      const keyErr = validateRedisKey(req.headers["x-redis-key"]);
      if (keyErr) { badRequest(res, keyErr); return; }
      const key = req.headers["x-redis-key"] as string;

      const expResult = validateExpire(req.headers["x-redis-expire"]);
      if ("error" in expResult) { badRequest(res, expResult.error); return; }

      if (!ensureRedisTunnel()) { res.writeHead(502); res.end('{"error":"redis tunnel unavailable"}'); return; }
      const data = await readRawBody(req);
      // execFileSync with array args — no shell interpolation
      execFileSync("redis-cli", ["--raw", "-x", "SETEX", key, String(expResult.seconds)], {
        input: data, timeout: 15000, stdio: ["pipe", "ignore", "ignore"],
      });
      res.writeHead(200); res.end('{"ok":true}');

    } else if (path === "redis-getz") {
      const keyErr = validateRedisKey(req.headers["x-redis-key"]);
      if (keyErr) { badRequest(res, keyErr); return; }
      const key = req.headers["x-redis-key"] as string;

      if (!ensureRedisTunnel()) { res.writeHead(502); res.end('{"error":"redis tunnel unavailable"}'); return; }
      // execFileSync with array args — no shell interpolation
      const raw = execFileSync("redis-cli", ["--raw", "GET", key], { timeout: 10000 });
      if (!raw.length || raw.toString().trim() === "") {
        res.writeHead(404); res.end('{"error":"key not found"}'); return;
      }
      if (raw[0] === 0x1f && raw[1] === 0x8b) {
        const { gunzipSync } = await import("zlib");
        const decompressed = gunzipSync(raw.subarray(0, raw.length - 1));
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(decompressed);
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(raw);
      }

    } else if (path === "redis-publish") {
      const body = JSON.parse((await readRawBody(req)).toString());
      const chErr = validateRedisKey(body.channel);
      if (chErr) { badRequest(res, chErr); return; }
      if (!body.message) { badRequest(res, "missing message"); return; }

      if (!ensureRedisTunnel()) { res.writeHead(502); res.end('{"error":"redis tunnel unavailable"}'); return; }
      // execFileSync with array args — no shell interpolation
      execFileSync("redis-cli", ["PUBLISH", body.channel, body.message], { timeout: 5000, stdio: "ignore" });
      res.writeHead(200); res.end('{"ok":true}');

    } else if (path === "cache-disk-transfer") {
      const keyErr = validateCacheKey(req.headers["x-cache-key"]);
      if (keyErr) { badRequest(res, keyErr); return; }
      const key = req.headers["x-cache-key"] as string;

      const subfolder = req.headers["x-cache-subfolder"] as string | undefined;
      if (subfolder) {
        const sfErr = validateSubfolder(subfolder);
        if (sfErr) { badRequest(res, sfErr); return; }
      }

      const data = await readRawBody(req);
      const dir = subfolder || key.slice(0, 4);
      // key and dir are validated as hex-only / alphanumeric-only — no metacharacters possible
      const cmd = `mkdir -p /logs-disk/${dir} && cat > /logs-disk/${dir}/${key}.log.gz`;
      const ssh = spawn("ssh", [
        "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
        "-i", SSH_KEY_PATH,
        `ubuntu@${BASTION_HOST}`, cmd,
      ], { stdio: ["pipe", "ignore", "ignore"] });
      ssh.stdin.end(data);
      await new Promise<void>((resolve, reject) => {
        ssh.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ssh exit ${code}`)));
        ssh.on("error", reject);
      });
      res.writeHead(200); res.end('{"ok":true}');

    } else {
      res.writeHead(404); res.end('{"error":"unknown credential endpoint"}');
    }
  } catch (e: any) {
    console.error(`[Creds] ${path}: ${e.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  }
}
