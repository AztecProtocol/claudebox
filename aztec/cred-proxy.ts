/**
 * Aztec CI Credential Proxy — proxies Redis, SSH, and disk transfer operations
 * for Claude containers that don't have direct access to credentials.
 *
 * This is Aztec-specific infrastructure. The proxy is registered as an HTTP
 * handler on the MCP sidecar server.
 */

import { execFileSync, execSync, spawn, type ChildProcess } from "child_process";
import type { IncomingMessage, ServerResponse } from "http";

const REDIS_HOST = "ci-redis-tiered.lzka0i.ng.0001.use2.cache.amazonaws.com";
const BASTION_HOST = "ci-bastion.aztecprotocol.com";
const SSH_KEY_PATH = "/home/claude/.ssh/build_instance_key";

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

/**
 * Handle a credential proxy request. Call this when req.url starts with "/creds/".
 */
export async function handleCredentialRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url!.replace("/creds/", "");
  if (path !== "redis-getz" && req.method !== "POST") {
    res.writeHead(405); res.end('{"error":"method not allowed"}'); return;
  }

  try {
    const redisKeyPattern = /^[a-zA-Z0-9:._\/-]+$/;
    const hasTraversal = (k: string) => k.includes("..") || k.startsWith("/");
    if (path === "redis-setexz") {
      const key = req.headers["x-redis-key"] as string;
      const expire = req.headers["x-redis-expire"] as string;
      if (!key || !expire) { res.writeHead(400); res.end('{"error":"missing key/expire headers"}'); return; }
      if (!redisKeyPattern.test(key) || hasTraversal(key)) { res.writeHead(400); res.end('{"error":"invalid key"}'); return; }
      const expireNum = parseInt(expire, 10);
      if (isNaN(expireNum) || expireNum <= 0 || expireNum > 2592000) { res.writeHead(400); res.end('{"error":"invalid expire (must be 1-2592000)"}'); return; }
      if (!ensureRedisTunnel()) { res.writeHead(502); res.end('{"error":"redis tunnel unavailable"}'); return; }
      const data = await readRawBody(req);
      execFileSync("redis-cli", ["--raw", "-x", "SETEX", key, String(expireNum)], { input: data, timeout: 15000, stdio: ["pipe", "ignore", "ignore"] });
      res.writeHead(200); res.end('{"ok":true}');
    } else if (path === "redis-publish") {
      const body = JSON.parse((await readRawBody(req)).toString());
      if (!body.channel || !body.message) { res.writeHead(400); res.end('{"error":"missing channel/message"}'); return; }
      if (!redisKeyPattern.test(body.channel) || hasTraversal(body.channel)) { res.writeHead(400); res.end('{"error":"invalid channel"}'); return; }
      if (!ensureRedisTunnel()) { res.writeHead(502); res.end('{"error":"redis tunnel unavailable"}'); return; }
      execFileSync("redis-cli", ["PUBLISH", body.channel, body.message], { timeout: 5000, stdio: "ignore" });
      res.writeHead(200); res.end('{"ok":true}');
    } else if (path === "cache-disk-transfer") {
      const key = req.headers["x-cache-key"] as string;
      const subfolder = req.headers["x-cache-subfolder"] as string || undefined;
      if (!key) { res.writeHead(400); res.end('{"error":"missing key header"}'); return; }
      const safePattern = /^[a-zA-Z0-9._-]+$/;
      if (!safePattern.test(key)) { res.writeHead(400); res.end('{"error":"invalid key"}'); return; }
      if (subfolder && !safePattern.test(subfolder)) { res.writeHead(400); res.end('{"error":"invalid subfolder"}'); return; }
      const data = await readRawBody(req);
      const dir = subfolder || key.slice(0, 4);
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
    } else if (path === "redis-getz") {
      const key = req.headers["x-redis-key"] as string;
      if (!key) { res.writeHead(400); res.end('{"error":"missing key header"}'); return; }
      if (!redisKeyPattern.test(key) || hasTraversal(key)) { res.writeHead(400); res.end('{"error":"invalid key"}'); return; }
      if (!ensureRedisTunnel()) { res.writeHead(502); res.end('{"error":"redis tunnel unavailable"}'); return; }
      try {
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
      } catch (e: any) {
        res.writeHead(500); res.end(JSON.stringify({ error: `redis GET failed: ${e.message}` }));
      }
    } else {
      res.writeHead(404); res.end('{"error":"unknown credential endpoint"}');
    }
  } catch (e: any) {
    console.error(`[Creds] ${path}: ${e.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  }
}
