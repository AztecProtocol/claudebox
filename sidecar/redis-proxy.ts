#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Redis RESP Protocol Proxy with Command Whitelisting
 *
 * Security model:
 *   Claude's container connects to this proxy as if it were Redis.
 *   The proxy parses every RESP command, checks it against a strict allowlist,
 *   validates key arguments and TTL ranges, then forwards only permitted
 *   commands (as raw bytes) to the real upstream Redis. Responses from
 *   upstream are relayed back unmodified.
 *
 *   This prevents Claude from running dangerous commands like DEL, KEYS,
 *   FLUSHALL, CONFIG, EVAL, SCRIPT, etc.
 *
 * Dependency: redis-parser (npm) — used for incremental RESP protocol parsing.
 *   Install via: npm install redis-parser
 *   The import is dynamic (inside startRedisProxy) so that validation functions
 *   can be imported and tested without redis-parser installed.
 */

import * as net from "net";

// ── Configuration ──────────────────────────────────────────────────

const DEFAULT_PROXY_PORT = 6379;
const DEFAULT_UPSTREAM_HOST = "localhost";
const DEFAULT_UPSTREAM_PORT = 6379;

// ── Command Allowlist ──────────────────────────────────────────────
// Only these commands may pass through the proxy. Everything else is rejected.

const ALLOWED_COMMANDS = new Set(["GET", "SETEX", "PUBLISH", "PING", "QUIT"]);

// Commands that take a key as their first argument (index 1 in the args array).
// PUBLISH's first arg is a channel name — we validate it the same way as a key.
const COMMANDS_WITH_KEY = new Set(["GET", "SETEX", "PUBLISH"]);

// SETEX TTL limits (seconds)
const MIN_TTL = 1;
const MAX_TTL = 2_592_000; // 30 days

// Key constraints
const MAX_KEY_LENGTH = 256;
const KEY_PATTERN = /^[a-zA-Z0-9:._\/-]+$/;

// ── Validation Functions ───────────────────────────────────────────

/**
 * Validate a Redis key (or channel name).
 * Returns a human-readable error string, or null if valid.
 */
export function validateRedisKey(key: string): string | null {
  if (key.length === 0) return "missing key";
  if (key.length > MAX_KEY_LENGTH) return "key too long";
  if (!/^[a-zA-Z0-9:._\/-]+$/.test(key)) return "invalid characters in key";
  if (key.includes("..")) return "path traversal in key";
  if (key.startsWith("/")) return "absolute path in key";
  return null;
}

/**
 * Validate SETEX TTL (the second argument, an integer in seconds).
 * Returns an error string, or null if valid.
 */
export function validateSetexTtl(ttlArg: string): string | null {
  const ttl = Number(ttlArg);
  if (!Number.isInteger(ttl)) return "TTL must be an integer";
  if (ttl < MIN_TTL) return "TTL too small";
  if (ttl > MAX_TTL) return "TTL exceeds 30-day maximum";
  return null;
}

/**
 * Check whether a parsed command (array of string args) is allowed.
 * Returns null if allowed, or a RESP error string if rejected.
 */
export function checkCommand(args: string[]): string | null {
  if (args.length === 0) return "-ERR empty command\r\n";

  const cmd = args[0].toUpperCase();

  // 1. Command allowlist
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return "-ERR command not allowed\r\n";
  }

  // 2. Key validation for commands that carry a key
  if (COMMANDS_WITH_KEY.has(cmd)) {
    if (args.length < 2) return "-ERR invalid key\r\n";
    const keyErr = validateRedisKey(args[1]);
    if (keyErr) return "-ERR invalid key\r\n";
  }

  // 3. SETEX-specific: validate TTL (second arg) and that value is present
  if (cmd === "SETEX") {
    // SETEX key ttl value — needs exactly 4 args
    if (args.length < 4) return "-ERR wrong number of arguments for 'SETEX' command\r\n";
    const ttlErr = validateSetexTtl(args[2]);
    if (ttlErr) return `-ERR ${ttlErr}\r\n`;
  }

  return null; // allowed
}

// ── RESP Helpers ───────────────────────────────────────────────────

function respError(msg: string): Buffer {
  // msg is already a full RESP error line like "-ERR command not allowed\r\n"
  return Buffer.from(msg, "utf-8");
}

/**
 * Compute the byte length of a single RESP array command in a buffer
 * starting at `offset`. Returns the number of bytes consumed, or -1
 * if the buffer is incomplete.
 */
export function respArrayLength(buf: Buffer, offset: number): number {
  let pos = offset;

  // Must start with '*'
  if (pos >= buf.length || buf[pos] !== 0x2a) return -1; // '*'
  pos++;

  // Read count line
  const countLineEnd = findCRLF(buf, pos);
  if (countLineEnd === -1) return -1;
  const count = parseInt(buf.subarray(pos, countLineEnd).toString(), 10);
  pos = countLineEnd + 2; // skip \r\n

  // Read `count` bulk strings
  for (let i = 0; i < count; i++) {
    if (pos >= buf.length) return -1;
    if (buf[pos] !== 0x24) return -1; // '$'
    pos++;
    const lenLineEnd = findCRLF(buf, pos);
    if (lenLineEnd === -1) return -1;
    const strLen = parseInt(buf.subarray(pos, lenLineEnd).toString(), 10);
    pos = lenLineEnd + 2; // skip \r\n
    pos += strLen + 2; // skip string data + \r\n
    if (pos > buf.length) return -1;
  }

  return pos - offset;
}

function findCRLF(buf: Buffer, from: number): number {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

// ── Proxy Options ──────────────────────────────────────────────────

export interface RedisProxyOpts {
  /** Port the proxy listens on (default: 6379 or REDIS_PROXY_PORT env) */
  proxyPort?: number;
  /** Upstream Redis host (default: localhost or REDIS_UPSTREAM_HOST env) */
  upstreamHost?: string;
  /** Upstream Redis port (default: 6379 or REDIS_UPSTREAM_PORT env) */
  upstreamPort?: number;
}

// ── Core Proxy Logic ───────────────────────────────────────────────

/**
 * Start the Redis proxy server.
 * Returns the net.Server instance (for testing or lifecycle management).
 *
 * redis-parser is imported dynamically here so that the pure validation
 * functions above can be imported and unit-tested without the dependency.
 */
export async function startRedisProxy(opts: RedisProxyOpts = {}): Promise<net.Server> {
  // Dynamic import — redis-parser is only needed at runtime, not for tests.
  // @ts-ignore — redis-parser provides no built-in types
  const { default: Parser } = await import("redis-parser");

  const proxyPort =
    opts.proxyPort ??
    parseInt(process.env.REDIS_PROXY_PORT || String(DEFAULT_PROXY_PORT), 10);
  const upstreamHost =
    opts.upstreamHost ?? (process.env.REDIS_UPSTREAM_HOST || DEFAULT_UPSTREAM_HOST);
  const upstreamPort =
    opts.upstreamPort ??
    parseInt(process.env.REDIS_UPSTREAM_PORT || String(DEFAULT_UPSTREAM_PORT), 10);

  const server = net.createServer((clientSocket) => {
    // Each client connection gets its own upstream connection.
    const upstreamSocket = net.createConnection(
      { host: upstreamHost, port: upstreamPort },
      () => {
        // Upstream connected — start processing client data.
      }
    );

    // Track raw bytes so we can forward allowed commands verbatim.
    // redis-parser calls returnReply when a complete command array is parsed;
    // we accumulate raw bytes and slice them per-command.
    let rawBuffer = Buffer.alloc(0);
    let parsedOffset = 0;

    const parser = new Parser({
      returnReply: (reply: string[]) => {
        // `reply` is the parsed command as an array of strings/buffers.
        // Convert to string array for validation.
        const args: string[] = Array.isArray(reply)
          ? reply.map((r: any) => (Buffer.isBuffer(r) ? r.toString() : String(r)))
          : [String(reply)];

        // Find the raw bytes for this command in the buffer.
        const cmdLen = respArrayLength(rawBuffer, parsedOffset);

        const err = checkCommand(args);
        if (err) {
          // Log the rejected command name only (not args, to avoid data leaks).
          const cmdName = args.length > 0 ? args[0].toUpperCase() : "(empty)";
          process.stderr.write(
            `[redis-proxy] REJECTED: ${cmdName} (${err.trim()})\n`
          );
          clientSocket.write(respError(err));
        } else {
          // Forward raw bytes to upstream, preserving binary data perfectly.
          if (cmdLen > 0) {
            upstreamSocket.write(rawBuffer.subarray(parsedOffset, parsedOffset + cmdLen));
          }
        }

        // Advance the parsed offset.
        if (cmdLen > 0) {
          parsedOffset += cmdLen;
        }
      },
      returnError: (err: Error) => {
        process.stderr.write(
          `[redis-proxy] RESP parse error: ${err.message}\n`
        );
        clientSocket.write(respError("-ERR protocol error\r\n"));
      },
      returnBuffers: false,
    });

    clientSocket.on("data", (data: Buffer) => {
      // Append new data to our raw buffer.
      rawBuffer = Buffer.concat([rawBuffer, data]);
      // Feed to parser — it will call returnReply for each complete command.
      parser.execute(data);
      // Compact the raw buffer: discard already-processed bytes.
      if (parsedOffset > 0) {
        rawBuffer = rawBuffer.subarray(parsedOffset);
        parsedOffset = 0;
      }
    });

    // Relay upstream responses back to client verbatim.
    upstreamSocket.on("data", (data: Buffer) => {
      clientSocket.write(data);
    });

    // Clean up on close/error from either side.
    clientSocket.on("end", () => {
      upstreamSocket.end();
    });
    clientSocket.on("error", (err) => {
      process.stderr.write(`[redis-proxy] client error: ${err.message}\n`);
      upstreamSocket.destroy();
    });

    upstreamSocket.on("end", () => {
      clientSocket.end();
    });
    upstreamSocket.on("error", (err) => {
      process.stderr.write(
        `[redis-proxy] upstream error: ${err.message}\n`
      );
      clientSocket.destroy();
    });
  });

  server.listen(proxyPort, () => {
    process.stderr.write(
      `[redis-proxy] listening on :${proxyPort}, upstream ${upstreamHost}:${upstreamPort}\n`
    );
  });

  return server;
}

// ── Graceful Shutdown ──────────────────────────────────────────────

function gracefulShutdown(server: net.Server) {
  process.stderr.write("[redis-proxy] shutting down...\n");
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5s if connections don't drain.
  setTimeout(() => process.exit(1), 5000).unref();
}

// ── Standalone Entry Point ─────────────────────────────────────────

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("redis-proxy.ts");

if (isMain) {
  startRedisProxy().then((server) => {
    process.on("SIGTERM", () => gracefulShutdown(server));
    process.on("SIGINT", () => gracefulShutdown(server));
  });
}
