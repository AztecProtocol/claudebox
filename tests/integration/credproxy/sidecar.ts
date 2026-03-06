/**
 * Minimal cred-proxy sidecar for testing.
 * Uses the same validation functions as aztec/cred-proxy.ts but talks
 * to the compose Redis instead of tunneling via SSH.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { execFileSync } from "child_process";
import { gunzipSync } from "zlib";

const REDIS_HOST = process.env.REDIS_HOST || "redis";

// ── Validators (mirrored from aztec/cred-proxy.ts) ──

function validateRedisKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return "missing key";
  if (key.length > 256) return "key too long";
  if (!/^[a-zA-Z0-9:._\/-]+$/.test(key)) return "invalid characters in key";
  if (key.includes("..")) return "path traversal in key";
  if (key.startsWith("/")) return "absolute path in key";
  return null;
}

function validateExpire(expire: unknown): { seconds: number } | { error: string } {
  if (typeof expire !== "string" || expire.length === 0) return { error: "missing expire" };
  const n = parseInt(expire, 10);
  if (isNaN(n) || n <= 0 || n > 2592000) return { error: "expire must be 1-2592000" };
  return { seconds: n };
}

function readBody(req: IncomingMessage, max = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > max) { req.destroy(); reject(new Error("too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function badRequest(res: ServerResponse, error: string): void {
  res.writeHead(400); res.end(JSON.stringify({ error }));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || "";

  if (url === "/health") {
    res.end("ok");
    return;
  }

  const path = url.replace("/creds/", "");

  try {
    if (path === "redis-setexz") {
      const keyErr = validateRedisKey(req.headers["x-redis-key"]);
      if (keyErr) { badRequest(res, keyErr); return; }
      const key = req.headers["x-redis-key"] as string;

      const expResult = validateExpire(req.headers["x-redis-expire"]);
      if ("error" in expResult) { badRequest(res, expResult.error); return; }

      const data = await readBody(req);
      execFileSync("redis-cli", ["--raw", "-h", REDIS_HOST, "-x", "SETEX", key, String(expResult.seconds)], {
        input: data, timeout: 5000, stdio: ["pipe", "ignore", "ignore"],
      });
      res.writeHead(200); res.end('{"ok":true}');

    } else if (path === "redis-getz") {
      const keyErr = validateRedisKey(req.headers["x-redis-key"]);
      if (keyErr) { badRequest(res, keyErr); return; }
      const key = req.headers["x-redis-key"] as string;

      const raw = execFileSync("redis-cli", ["--raw", "-h", REDIS_HOST, "GET", key], { timeout: 5000 });
      if (!raw.length || raw.toString().trim() === "") {
        res.writeHead(404); res.end('{"error":"key not found"}'); return;
      }
      if (raw[0] === 0x1f && raw[1] === 0x8b) {
        const decompressed = gunzipSync(raw.subarray(0, raw.length - 1));
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(decompressed);
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(raw);
      }

    } else if (path === "redis-publish") {
      const body = JSON.parse((await readBody(req)).toString());
      const chErr = validateRedisKey(body.channel);
      if (chErr) { badRequest(res, chErr); return; }
      if (!body.message) { badRequest(res, "missing message"); return; }

      execFileSync("redis-cli", ["--raw", "-h", REDIS_HOST, "PUBLISH", body.channel, body.message], {
        timeout: 5000, stdio: "ignore",
      });
      res.writeHead(200); res.end('{"ok":true}');

    } else {
      res.writeHead(404); res.end('{"error":"unknown endpoint"}');
    }
  } catch (e: any) {
    console.error(`[sidecar] ${path}: ${e.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  }
});

server.listen(9801, () => console.log("[sidecar] listening on :9801"));
