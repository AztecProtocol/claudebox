/**
 * HTTP Forward Proxy with Domain Allowlisting
 *
 * Security model:
 * - Acts as a forward proxy for Claude containers via HTTP_PROXY/HTTPS_PROXY env vars.
 * - All outbound connections are checked against a domain allowlist before being established.
 * - HTTPS traffic uses CONNECT tunneling — we allow/deny based on hostname only, never
 *   performing MITM inspection. Once a tunnel is established, traffic flows opaquely.
 * - Plain HTTP requests are forwarded after hostname validation.
 * - Wildcard entries (e.g., *.s3.amazonaws.com) require at least one subdomain level —
 *   they do NOT match the bare domain itself to prevent bypass via suffix matching.
 */

import * as http from "node:http";
import * as net from "node:net";
import * as url from "node:url";

// ---------------------------------------------------------------------------
// Default allowlist
// ---------------------------------------------------------------------------

// Empty = allow all domains (no filtering)
const DEFAULT_ALLOWED_DOMAINS: string[] = [];

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

/**
 * Check whether `hostname` is permitted by the given allowlist.
 *
 * Rules:
 * - Exact match (case-insensitive).
 * - Wildcard entries starting with `*.` match any single-or-multi-level subdomain
 *   but NOT the bare suffix itself. E.g. `*.s3.amazonaws.com` matches
 *   `my-bucket.s3.amazonaws.com` but not `s3.amazonaws.com`.
 * - Hostnames containing path separators, whitespace, or other special characters
 *   are rejected outright (prevents header-injection style attacks).
 */
export function matchesDomain(
  hostname: string,
  allowlist: string[],
): boolean {
  // Reject anything that looks like it contains a path, query, or special chars.
  // Valid hostnames contain only alphanumeric, hyphens, and dots.
  if (!/^[a-zA-Z0-9.\-]+$/.test(hostname)) {
    return false;
  }

  // Reject empty hostname
  if (hostname.length === 0) {
    return false;
  }

  // Empty allowlist = allow all domains
  if (allowlist.length === 0) return true;

  const lower = hostname.toLowerCase();

  for (const entry of allowlist) {
    const entryLower = entry.toLowerCase();

    if (entryLower.startsWith("*.")) {
      // Wildcard: *.example.com should match sub.example.com but NOT example.com
      const suffix = entryLower.slice(1); // ".example.com"
      if (lower.endsWith(suffix) && lower.length > suffix.length) {
        return true;
      }
    } else {
      // Exact match
      if (lower === entryLower) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Proxy options
// ---------------------------------------------------------------------------

export interface HttpProxyOpts {
  /** Port to listen on. Default: 8080 or HTTP_PROXY_PORT env var. */
  port?: number;
  /** Domain allowlist. Default: DEFAULT_ALLOWED_DOMAINS or ALLOWED_DOMAINS env var. */
  allowedDomains?: string[];
  /** Max concurrent tunnelled connections. Default: 100. */
  maxConnections?: number;
  /** Connection timeout in ms. Default: 30_000. */
  connectTimeout?: number;
  /** Idle timeout on established tunnels in ms. Default: 300_000 (5 min). */
  idleTimeout?: number;
}

// ---------------------------------------------------------------------------
// Proxy implementation
// ---------------------------------------------------------------------------

export function startHttpProxy(opts: HttpProxyOpts = {}): http.Server {
  const port =
    opts.port ??
    (process.env.HTTP_PROXY_PORT ? parseInt(process.env.HTTP_PROXY_PORT, 10) : 8080);

  const allowedDomains =
    opts.allowedDomains ??
    (process.env.ALLOWED_DOMAINS
      ? process.env.ALLOWED_DOMAINS.split(",").map((d) => d.trim()).filter(Boolean)
      : DEFAULT_ALLOWED_DOMAINS);

  const maxConnections = opts.maxConnections ?? 100;
  const connectTimeout = opts.connectTimeout ?? 30_000;
  const idleTimeout = opts.idleTimeout ?? 300_000;

  let activeConnections = 0;

  // -----------------------------------------------------------------------
  // Plain HTTP forwarding (non-CONNECT requests)
  // -----------------------------------------------------------------------

  const server = http.createServer((clientReq, clientRes) => {
    // Parse the target URL from the request
    const targetUrl = clientReq.url;
    if (!targetUrl) {
      clientRes.writeHead(400, { "Content-Type": "text/plain" });
      clientRes.end("Bad Request: missing URL\n");
      return;
    }

    let parsed: url.URL;
    try {
      parsed = new url.URL(targetUrl);
    } catch {
      clientRes.writeHead(400, { "Content-Type": "text/plain" });
      clientRes.end("Bad Request: invalid URL\n");
      return;
    }

    const hostname = parsed.hostname;

    if (!matchesDomain(hostname, allowedDomains)) {
      console.error(`[http-proxy] BLOCKED plain HTTP to: ${hostname}`);
      clientRes.writeHead(403, { "Content-Type": "text/plain" });
      clientRes.end("Forbidden: domain not in allowlist\n");
      return;
    }

    if (activeConnections >= maxConnections) {
      clientRes.writeHead(503, { "Content-Type": "text/plain" });
      clientRes.end("Service Unavailable: too many connections\n");
      return;
    }

    activeConnections++;

    const proxyReqOpts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: clientReq.method,
      headers: { ...clientReq.headers },
      timeout: connectTimeout,
    };

    // Remove proxy-specific headers
    delete proxyReqOpts.headers!["proxy-connection"];

    const proxyReq = http.request(proxyReqOpts, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(clientRes);
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      activeConnections = Math.max(0, activeConnections - 1);
      if (!clientRes.headersSent) {
        clientRes.writeHead(504, { "Content-Type": "text/plain" });
        clientRes.end("Gateway Timeout\n");
      }
    });

    proxyReq.on("error", (err) => {
      activeConnections = Math.max(0, activeConnections - 1);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
        clientRes.end(`Bad Gateway: ${err.message}\n`);
      }
    });

    proxyReq.on("close", () => {
      activeConnections = Math.max(0, activeConnections - 1);
    });

    clientReq.pipe(proxyReq);
  });

  // -----------------------------------------------------------------------
  // CONNECT handler for HTTPS tunneling
  // -----------------------------------------------------------------------

  server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const target = req.url ?? "";
    const [hostname, portStr] = target.split(":");
    const port = parseInt(portStr, 10) || 443;

    if (!hostname || !matchesDomain(hostname, allowedDomains)) {
      console.error(`[http-proxy] BLOCKED CONNECT to: ${hostname || "(empty)"}`);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }

    if (activeConnections >= maxConnections) {
      clientSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      clientSocket.end();
      return;
    }

    activeConnections++;

    const targetSocket = net.connect({ host: hostname, port, timeout: connectTimeout }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      // Set idle timeouts on both ends of the tunnel
      targetSocket.setTimeout(idleTimeout);
      clientSocket.setTimeout(idleTimeout);

      // Send any buffered data that arrived with the CONNECT request
      if (head.length > 0) {
        targetSocket.write(head);
      }

      // Bidirectional piping — transparent tunnel, no MITM
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });

    const cleanup = () => {
      activeConnections = Math.max(0, activeConnections - 1);
      targetSocket.destroy();
      clientSocket.destroy();
    };

    targetSocket.on("timeout", cleanup);
    clientSocket.on("timeout", cleanup);

    targetSocket.on("error", (err) => {
      console.error(`[http-proxy] target socket error for ${hostname}: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      cleanup();
    });

    clientSocket.on("error", () => {
      cleanup();
    });

    targetSocket.on("close", () => {
      activeConnections = Math.max(0, activeConnections - 1);
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    });

    clientSocket.on("close", () => {
      if (!targetSocket.destroyed) {
        targetSocket.destroy();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Clean shutdown
  // -----------------------------------------------------------------------

  const shutdown = () => {
    console.error("[http-proxy] Shutting down...");
    server.close(() => {
      console.error("[http-proxy] Server closed.");
      process.exit(0);
    });
    // Force exit after 5 seconds if graceful shutdown stalls
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // -----------------------------------------------------------------------
  // Start listening
  // -----------------------------------------------------------------------

  server.listen(port, () => {
    console.error(`[http-proxy] Listening on port ${port}`);
    console.error(`[http-proxy] Allowed domains: ${allowedDomains.join(", ")}`);
    console.error(`[http-proxy] Max connections: ${maxConnections}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Standalone execution
// ---------------------------------------------------------------------------

// When run directly (not imported), start the proxy.
const isMain =
  typeof require !== "undefined" && require.main === module;
// Also support ESM-style detection via process.argv
const isDirectRun =
  isMain || process.argv[1]?.endsWith("http-proxy.ts") || process.argv[1]?.endsWith("http-proxy.js");

if (isDirectRun) {
  startHttpProxy();
}
