/**
 * Minimal cred-proxy sidecar for testing.
 * Implements the same HTTP endpoints as aztec/cred-proxy.ts but talks
 * to the compose Redis instead of tunneling via SSH.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { execFileSync } from "child_process";
import { gunzipSync } from "zlib";

const REDIS_HOST = process.env.REDIS_HOST || "redis";

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

function redisCli(...args: string[]): Buffer {
  return execFileSync("redis-cli", ["--raw", "-h", REDIS_HOST, ...args], { timeout: 5000 });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || "";

  if (url === "/health") {
    res.end("ok");
    return;
  }

  // Strip /creds/ prefix
  const path = url.replace("/creds/", "");
  const keyPattern = /^[a-zA-Z0-9:._\/-]+$/;
  const hasTraversal = (k: string) => k.includes("..") || k.startsWith("/");

  try {
    if (path === "redis-setexz") {
      const key = req.headers["x-redis-key"] as string;
      const expire = req.headers["x-redis-expire"] as string;
      if (!key || !expire) { res.writeHead(400); res.end('{"error":"missing key/expire"}'); return; }
      if (!keyPattern.test(key) || hasTraversal(key)) { res.writeHead(400); res.end('{"error":"invalid key"}'); return; }
      const expireNum = parseInt(expire, 10);
      if (isNaN(expireNum) || expireNum <= 0 || expireNum > 2592000) {
        res.writeHead(400); res.end('{"error":"invalid expire"}'); return;
      }
      const data = await readBody(req);
      execFileSync("redis-cli", ["--raw", "-h", REDIS_HOST, "-x", "SETEX", key, String(expireNum)], {
        input: data, timeout: 5000, stdio: ["pipe", "ignore", "ignore"],
      });
      res.writeHead(200); res.end('{"ok":true}');

    } else if (path === "redis-getz") {
      const key = req.headers["x-redis-key"] as string;
      if (!key) { res.writeHead(400); res.end('{"error":"missing key"}'); return; }
      if (!keyPattern.test(key) || hasTraversal(key)) { res.writeHead(400); res.end('{"error":"invalid key"}'); return; }
      const raw = redisCli("GET", key);
      if (!raw.length || raw.toString().trim() === "") {
        res.writeHead(404); res.end('{"error":"key not found"}'); return;
      }
      // Check gzip magic bytes
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
      if (!body.channel || !body.message) { res.writeHead(400); res.end('{"error":"missing channel/message"}'); return; }
      redisCli("PUBLISH", body.channel, body.message);
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
