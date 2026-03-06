import * as net from "net";
import * as http from "http";
import * as zlib from "zlib";

// ---------------------------------------------------------------------------
// Test framework
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// RESP helpers
// ---------------------------------------------------------------------------

function encodeResp(...args: string[]): Buffer {
  let cmd = `*${args.length}\r\n`;
  for (const arg of args) {
    cmd += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  }
  return Buffer.from(cmd);
}

async function sendCommand(
  host: string,
  port: number,
  ...args: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => {
      sock.write(encodeResp(...args));
    });
    let data = "";
    sock.on("data", (chunk) => {
      data += chunk.toString();
    });
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error("timeout"));
    });
    // For simple commands, close after first response
    setTimeout(() => {
      sock.end();
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// HTTP proxy helpers
// ---------------------------------------------------------------------------

function httpGet(
  proxyHost: string,
  proxyPort: number,
  targetUrl: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const req = http.request(
      {
        host: proxyHost,
        port: proxyPort,
        method: "GET",
        path: targetUrl,
        headers: { Host: url.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function httpConnect(
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number
): Promise<{ statusCode: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
    });
    req.on("connect", (res, socket) => {
      resolve({ statusCode: res.statusCode || 0, socket });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Service readiness
// ---------------------------------------------------------------------------

async function waitForPort(
  host: string,
  port: number,
  label: string,
  retries = 30,
  delayMs = 1000
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(port, host, () => {
          sock.end();
          resolve();
        });
        sock.on("error", reject);
        sock.setTimeout(1000, () => {
          sock.destroy();
          reject(new Error("timeout"));
        });
      });
      console.log(`[wait] ${label} is ready`);
      return;
    } catch {
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw new Error(`${label} not ready after ${retries} retries`);
}

async function waitForServices() {
  const host = process.env.SIDECAR_HOST || "sidecar";
  console.log("[wait] Waiting for sidecar services...");
  await Promise.all([
    waitForPort(host, 6379, "Redis proxy"),
    waitForPort(host, 8080, "HTTP proxy"),
  ]);
}

// ---------------------------------------------------------------------------
// A. Redis Proxy Tests
// ---------------------------------------------------------------------------

async function redisTests() {
  console.log("\n=== A. Redis Proxy Tests ===\n");
  const host = process.env.SIDECAR_HOST || "sidecar";
  const port = 6379;

  // 1. PING works through proxy
  {
    const resp = await sendCommand(host, port, "PING");
    assert(resp.includes("+PONG"), "PING works through proxy");
  }

  // 2. GET + SETEX roundtrip
  {
    const key = "test:roundtrip:" + Date.now();
    const value = "hello-world";
    const setResp = await sendCommand(host, port, "SETEX", key, "60", value);
    assert(setResp.includes("+OK"), "SETEX succeeds");

    const getResp = await sendCommand(host, port, "GET", key);
    assert(getResp.includes(value), "GET returns the value written by SETEX");
  }

  // 3. SETEX with gzipped data roundtrip
  {
    const key = "test:gzip:" + Date.now();
    const original = "This is some data that will be gzipped for the roundtrip test.";
    const gzipped = zlib.gzipSync(Buffer.from(original));
    // Encode the gzipped binary as base64 for safe RESP transport
    const b64 = gzipped.toString("base64");
    const setResp = await sendCommand(host, port, "SETEX", key, "60", b64);
    assert(setResp.includes("+OK"), "SETEX with gzipped (base64) data succeeds");

    const getResp = await sendCommand(host, port, "GET", key);
    // Extract the bulk string value from the RESP response
    // Format: $<len>\r\n<data>\r\n
    const match = getResp.match(/\$\d+\r\n(.+)\r\n/);
    const retrieved = match ? match[1] : "";
    const decompressed = zlib.gunzipSync(Buffer.from(retrieved, "base64")).toString();
    assert(
      decompressed === original,
      "SETEX with gzipped data roundtrip preserves binary data"
    );
  }

  // 4. PUBLISH succeeds
  {
    const resp = await sendCommand(host, port, "PUBLISH", "test-channel", "hello");
    // PUBLISH returns an integer (number of receivers), e.g. :0\r\n
    assert(resp.startsWith(":"), "PUBLISH succeeds");
  }

  // 5. DEL is rejected
  {
    const resp = await sendCommand(host, port, "DEL", "somekey");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted"),
      "DEL is rejected (not in allowlist)"
    );
  }

  // 6. KEYS * is rejected
  {
    const resp = await sendCommand(host, port, "KEYS", "*");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted"),
      "KEYS * is rejected"
    );
  }

  // 7. FLUSHALL is rejected
  {
    const resp = await sendCommand(host, port, "FLUSHALL");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted"),
      "FLUSHALL is rejected"
    );
  }

  // 8. CONFIG GET is rejected
  {
    const resp = await sendCommand(host, port, "CONFIG", "GET", "save");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted"),
      "CONFIG GET is rejected"
    );
  }

  // 9. EVAL (Lua scripting) is rejected
  {
    const resp = await sendCommand(host, port, "EVAL", "return 1", "0");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted"),
      "EVAL (Lua scripting) is rejected"
    );
  }

  // 10. Key with path traversal is rejected
  {
    const resp = await sendCommand(host, port, "GET", "../etc/passwd");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted") || resp.includes("invalid"),
      "Key with path traversal (../etc/passwd) is rejected"
    );
  }

  // 11. Key with shell injection is rejected
  {
    const resp = await sendCommand(host, port, "GET", "key;rm -rf /");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted") || resp.includes("invalid"),
      "Key with shell injection (key;rm -rf /) is rejected"
    );
  }

  // 12. Key too long (300 chars) is rejected
  {
    const longKey = "k".repeat(300);
    const resp = await sendCommand(host, port, "GET", longKey);
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted") || resp.includes("too long"),
      "Key too long (300 chars) is rejected"
    );
  }

  // 13. SETEX with negative TTL is rejected
  {
    const resp = await sendCommand(host, port, "SETEX", "test:negttl", "-1", "val");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted") || resp.includes("invalid"),
      "SETEX with negative TTL is rejected"
    );
  }

  // 14. SETEX with TTL > 30 days is rejected
  {
    const ttl = String(31 * 24 * 60 * 60); // 31 days in seconds
    const resp = await sendCommand(host, port, "SETEX", "test:longttl", ttl, "val");
    assert(
      resp.includes("-ERR") || resp.includes("-FORBIDDEN") || resp.includes("not allowed") || resp.includes("not permitted") || resp.includes("invalid") || resp.includes("too large"),
      "SETEX with TTL > 30 days is rejected"
    );
  }
}

// ---------------------------------------------------------------------------
// B. HTTP Proxy Tests
// ---------------------------------------------------------------------------

async function httpProxyTests() {
  console.log("\n=== B. HTTP Proxy Tests ===\n");
  const proxyHost = process.env.SIDECAR_HOST || "sidecar";
  const proxyPort = 8080;

  // 1. HTTP request to allowed domain (echo-server) succeeds
  {
    try {
      const { statusCode, body } = await httpGet(
        proxyHost,
        proxyPort,
        "http://echo-server/"
      );
      assert(statusCode === 200, "HTTP request to allowed domain (echo-server) succeeds");
      const parsed = JSON.parse(body);
      assert(parsed.method === "GET", "Echo server received GET method");
    } catch (err: any) {
      assert(false, `HTTP request to allowed domain (echo-server) succeeds: ${err.message}`);
    }
  }

  // 2. HTTP request to blocked domain returns 403
  {
    try {
      const { statusCode } = await httpGet(
        proxyHost,
        proxyPort,
        "http://evil.com/"
      );
      assert(statusCode === 403, "HTTP request to blocked domain (evil.com) returns 403");
    } catch (err: any) {
      // Connection reset or refused also counts as blocked
      assert(
        err.message.includes("ECONNRESET") || err.message.includes("ECONNREFUSED"),
        `HTTP request to blocked domain (evil.com) is blocked: ${err.message}`
      );
    }
  }

  // 3. CONNECT to allowed domain succeeds
  {
    try {
      const { statusCode, socket } = await httpConnect(
        proxyHost,
        proxyPort,
        "echo-server",
        80
      );
      assert(statusCode === 200, "CONNECT to allowed domain (echo-server) succeeds");
      socket.destroy();
    } catch (err: any) {
      assert(false, `CONNECT to allowed domain (echo-server) succeeds: ${err.message}`);
    }
  }

  // 4. CONNECT to blocked domain returns 403
  {
    try {
      const { statusCode, socket } = await httpConnect(
        proxyHost,
        proxyPort,
        "evil.com",
        443
      );
      assert(statusCode === 403, "CONNECT to blocked domain (evil.com) returns 403");
      socket.destroy();
    } catch (err: any) {
      // Connection reset also counts as blocked
      assert(
        err.message.includes("ECONNRESET") ||
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("socket hang up"),
        `CONNECT to blocked domain (evil.com) is blocked: ${err.message}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// C. Combined Scenario
// ---------------------------------------------------------------------------

async function combinedScenario() {
  console.log("\n=== C. Combined Scenario (ci3-style workflow) ===\n");
  const host = process.env.SIDECAR_HOST || "sidecar";
  const port = 6379;

  // 1. Simulate ci3 workflow: SETEX -> GET -> PUBLISH
  const key = "ci3:job:result:" + Date.now();
  const payload = JSON.stringify({
    jobId: "test-123",
    status: "success",
    timestamp: new Date().toISOString(),
  });

  // SETEX the result with a 5-minute TTL
  const setResp = await sendCommand(host, port, "SETEX", key, "300", payload);
  assert(setResp.includes("+OK"), "ci3 workflow: SETEX job result succeeds");

  // GET it back
  const getResp = await sendCommand(host, port, "GET", key);
  assert(getResp.includes("test-123"), "ci3 workflow: GET retrieves the job result");

  // PUBLISH a notification
  const pubResp = await sendCommand(
    host,
    port,
    "PUBLISH",
    "ci3:notifications",
    JSON.stringify({ event: "job-complete", key })
  );
  assert(pubResp.startsWith(":"), "ci3 workflow: PUBLISH notification succeeds");

  // 2. Verify rejected commands were actually rejected (by trying one more)
  const badResp = await sendCommand(host, port, "FLUSHDB");
  assert(
    badResp.includes("-ERR") || badResp.includes("-FORBIDDEN") || badResp.includes("not allowed") || badResp.includes("not permitted"),
    "ci3 workflow: rejected command (FLUSHDB) is still rejected"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    await waitForServices();

    await redisTests();
    await httpProxyTests();
    await combinedScenario();

    console.log(`\n========================================`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`========================================\n`);

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(2);
  }
}

main();
