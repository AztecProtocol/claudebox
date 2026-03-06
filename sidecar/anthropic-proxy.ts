/**
 * Anthropic API Reverse Proxy
 *
 * Runs on the host, proxies Claude API requests from containers.
 * Containers never see real credentials — they send a session token via
 * ANTHROPIC_AUTH_TOKEN, and this proxy validates it and injects the real
 * OAuth access token before forwarding to api.anthropic.com.
 *
 * Security model:
 * - Validates incoming x-api-key / Authorization against allowed session tokens
 * - Refreshes OAuth tokens when they expire (reads from .credentials.json)
 * - Only forwards to api.anthropic.com (hardcoded upstream)
 * - Logs request counts, not contents
 *
 * Usage:
 *   In containers: ANTHROPIC_BASE_URL=http://host.docker.internal:8378
 *                  ANTHROPIC_AUTH_TOKEN=<session-token>
 */

import * as http from "node:http";
import * as https from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_PORT = parseInt(process.env.ANTHROPIC_PROXY_PORT || "8378", 10);
const UPSTREAM_PORT = 443;

// Allowed session tokens — callers must present one of these
// (populated at startup + via addSessionToken())
const allowedTokens = new Set<string>();

// ---------------------------------------------------------------------------
// OAuth credential management
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

interface OAuthCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  };
}

let cachedAccessToken: string | null = null;
let cachedExpiresAt: number = 0;

/**
 * Read the current OAuth access token from .credentials.json.
 * Caches the result and re-reads when the token is near expiry.
 */
function getAccessToken(): string {
  const now = Date.now();

  // Return cached token if still valid (with 5-minute buffer)
  if (cachedAccessToken && cachedExpiresAt > now + 5 * 60 * 1000) {
    return cachedAccessToken;
  }

  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    const creds: OAuthCredentials = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) {
      throw new Error("No claudeAiOauth.accessToken in credentials");
    }
    cachedAccessToken = oauth.accessToken;
    cachedExpiresAt = oauth.expiresAt || now + 3600_000;
    return cachedAccessToken;
  } catch (e: any) {
    // If we have a cached token, use it even if file read fails
    if (cachedAccessToken) {
      console.warn(`[anthropic-proxy] Failed to refresh token, using cached: ${e.message}`);
      return cachedAccessToken;
    }
    throw new Error(`Cannot read OAuth token: ${e.message}`);
  }
}

// Also support ANTHROPIC_API_KEY on the host as an alternative to OAuth
const HOST_API_KEY = process.env.ANTHROPIC_API_KEY || "";

function getUpstreamAuth(): { headerName: string; headerValue: string; host: string } {
  if (HOST_API_KEY) {
    return { headerName: "x-api-key", headerValue: HOST_API_KEY, host: "api.anthropic.com" };
  }
  const token = getAccessToken();
  return { headerName: "Authorization", headerValue: `Bearer ${token}`, host: "api.claude.ai" };
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

export function addSessionToken(token: string): void {
  if (token) allowedTokens.add(token);
}

export function removeSessionToken(token: string): void {
  allowedTokens.delete(token);
}

function validateToken(req: http.IncomingMessage): boolean {
  // No tokens configured = reject all (fail closed)
  if (allowedTokens.size === 0) return false;

  // Check x-api-key header
  const apiKey = req.headers["x-api-key"];
  if (apiKey && typeof apiKey === "string" && allowedTokens.has(apiKey)) return true;

  // Check Authorization: Bearer <token>
  const auth = req.headers["authorization"];
  if (auth && typeof auth === "string") {
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (allowedTokens.has(token)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Request stats
// ---------------------------------------------------------------------------

let requestCount = 0;
let errorCount = 0;
let bytesProxied = 0;

export function getStats() {
  return { requestCount, errorCount, bytesProxied, activeTokens: allowedTokens.size };
}

// ---------------------------------------------------------------------------
// Proxy implementation
// ---------------------------------------------------------------------------

export function startAnthropicProxy(opts?: {
  port?: number;
  initialTokens?: string[];
}): http.Server {
  const port = opts?.port ?? PROXY_PORT;

  // Seed initial tokens
  if (opts?.initialTokens) {
    for (const t of opts.initialTokens) addSessionToken(t);
  }

  const server = http.createServer((clientReq, clientRes) => {
    requestCount++;
    const method = clientReq.method || "GET";
    const path = clientReq.url || "/";

    // Health check endpoint
    if (path === "/health") {
      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ status: "ok", ...getStats() }));
      return;
    }

    // Only allow POST to Anthropic API paths
    const allowedPaths = ["/v1/messages", "/v1/messages/count_tokens", "/v1/messages/batches"];
    const isAllowed = allowedPaths.some(p => path.startsWith(p));
    if (!isAllowed) {
      errorCount++;
      console.warn(`[anthropic-proxy] BLOCKED ${method} ${path}`);
      clientRes.writeHead(403, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: "Path not allowed" }));
      return;
    }

    // Validate session token
    if (!validateToken(clientReq)) {
      errorCount++;
      console.warn(`[anthropic-proxy] AUTH_FAILED ${method} ${path}`);
      clientRes.writeHead(401, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: "Invalid or missing session token" }));
      return;
    }

    // Get real credentials
    let auth: { headerName: string; headerValue: string };
    try {
      auth = getUpstreamAuth();
    } catch (e: any) {
      errorCount++;
      console.error(`[anthropic-proxy] CRED_ERROR: ${e.message}`);
      clientRes.writeHead(502, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: "Proxy credential error" }));
      return;
    }

    // Build upstream request headers — copy client headers, replace auth
    const upstreamHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (!value) continue;
      // Skip auth headers — we'll inject real ones
      if (key === "x-api-key" || key === "authorization") continue;
      // Skip hop-by-hop headers
      if (key === "host" || key === "connection" || key === "transfer-encoding") continue;
      upstreamHeaders[key] = value;
    }

    // Inject real auth
    upstreamHeaders[auth.headerName] = auth.headerValue;
    upstreamHeaders["host"] = auth.host;

    // Forward to upstream
    const upstreamReq = https.request(
      {
        hostname: auth.host,
        port: UPSTREAM_PORT,
        path: path,
        method: method,
        headers: upstreamHeaders,
      },
      (upstreamRes) => {
        // Stream response back to client
        const statusCode = upstreamRes.statusCode ?? 502;
        const responseHeaders: Record<string, string | string[]> = {};

        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (!value) continue;
          // Skip hop-by-hop
          if (key === "transfer-encoding" && value === "chunked") {
            // Let Node handle chunked encoding
            continue;
          }
          responseHeaders[key] = value;
        }

        clientRes.writeHead(statusCode, responseHeaders);

        upstreamRes.on("data", (chunk: Buffer) => {
          bytesProxied += chunk.length;
          clientRes.write(chunk);
        });

        upstreamRes.on("end", () => {
          clientRes.end();
        });

        upstreamRes.on("error", (err) => {
          errorCount++;
          console.error(`[anthropic-proxy] UPSTREAM_RESP_ERROR: ${err.message}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(502);
          }
          clientRes.end();
        });
      },
    );

    upstreamReq.on("error", (err) => {
      errorCount++;
      console.error(`[anthropic-proxy] UPSTREAM_ERROR: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
      }
    });

    // Set timeout
    upstreamReq.setTimeout(600_000, () => {
      errorCount++;
      upstreamReq.destroy(new Error("Upstream timeout"));
    });

    // Pipe client body to upstream
    clientReq.on("data", (chunk: Buffer) => {
      upstreamReq.write(chunk);
    });

    clientReq.on("end", () => {
      upstreamReq.end();
    });

    clientReq.on("error", (err) => {
      upstreamReq.destroy(err);
    });
  });

  server.listen(port, () => {
    const upstream = HOST_API_KEY ? "api.anthropic.com" : "api.claude.ai";
    console.log(`[anthropic-proxy] Listening on port ${port}`);
    console.log(`[anthropic-proxy] Upstream: https://${upstream}`);
    console.log(`[anthropic-proxy] Auth mode: ${HOST_API_KEY ? "API key" : "OAuth"}`);
    console.log(`[anthropic-proxy] Session tokens: ${allowedTokens.size}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Standalone execution
// ---------------------------------------------------------------------------

const isDirectRun =
  process.argv[1]?.endsWith("anthropic-proxy.ts") ||
  process.argv[1]?.endsWith("anthropic-proxy.js");

if (isDirectRun) {
  const token = process.env.CLAUDEBOX_API_SECRET || process.env.CLAUDEBOX_SERVER_TOKEN;
  if (token) addSessionToken(token);
  startAnthropicProxy();
}
