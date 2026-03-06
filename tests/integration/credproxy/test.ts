/**
 * Test the cred-proxy endpoints from the "Claude container" perspective.
 * Uses AZTEC_MCP_SERVER env var, same as ci3/source_redis would.
 */
import { gzipSync } from "zlib";

const PROXY = process.env.AZTEC_MCP_SERVER!;
const TEST_KEY = `credproxy-test-${Date.now()}`;
const TEST_DATA = `Hello from credproxy test at ${new Date().toISOString()}\nLine 2\nLine 3`;

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✔ ${msg}`);
    passed++;
  } else {
    console.error(`  ✖ FAIL: ${msg}`);
    failed++;
  }
}

async function waitForSidecar(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const r = await fetch("http://sidecar:9801/health");
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Sidecar never became healthy");
}

async function testRedisSetexzAndGetz() {
  console.log("\n── redis-setexz + redis-getz (raw string) ──");

  // Write a raw (non-gzipped) value
  const rawKey = `${TEST_KEY}-raw`;
  const setRes = await fetch(`${PROXY}/redis-setexz`, {
    method: "POST",
    headers: {
      "X-Redis-Key": rawKey,
      "X-Redis-Expire": "60",
      "Content-Type": "application/octet-stream",
    },
    body: TEST_DATA,
  });
  assert(setRes.ok, `redis-setexz raw returned ${setRes.status}`);
  const setBody = await setRes.json();
  assert(setBody.ok === true, `redis-setexz body: ${JSON.stringify(setBody)}`);

  // Read it back
  const getRes = await fetch(`${PROXY}/redis-getz`, {
    headers: { "X-Redis-Key": rawKey },
  });
  assert(getRes.ok, `redis-getz raw returned ${getRes.status}`);
  const getText = await getRes.text();
  // Raw data goes through redis-cli which may append a newline
  assert(getText.trimEnd() === TEST_DATA || getText.includes("Hello from credproxy"),
    `redis-getz raw content matches (got ${getText.length} bytes)`);
}

async function testGzippedRoundtrip() {
  console.log("\n── redis-setexz + redis-getz (gzipped) ──");

  // Write gzipped data (this is what ci3's redis_setexz does: gzip | curl)
  const gzKey = `${TEST_KEY}-gz`;
  const gzData = gzipSync(Buffer.from(TEST_DATA));

  const setRes = await fetch(`${PROXY}/redis-setexz`, {
    method: "POST",
    headers: {
      "X-Redis-Key": gzKey,
      "X-Redis-Expire": "60",
      "Content-Type": "application/octet-stream",
    },
    body: gzData,
  });
  assert(setRes.ok, `redis-setexz gzip returned ${setRes.status}`);

  // Read it back — proxy should auto-decompress
  const getRes = await fetch(`${PROXY}/redis-getz`, {
    headers: { "X-Redis-Key": gzKey },
  });
  assert(getRes.ok, `redis-getz gzip returned ${getRes.status}`);
  const getText = await getRes.text();
  assert(getText.includes("Hello from credproxy"), `redis-getz decompressed correctly (got ${getText.length} bytes)`);
}

async function testRedisPublish() {
  console.log("\n── redis-publish ──");

  const pubRes = await fetch(`${PROXY}/redis-publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "test-channel", message: "hello from test" }),
  });
  assert(pubRes.ok, `redis-publish returned ${pubRes.status}`);
  const pubBody = await pubRes.json();
  assert(pubBody.ok === true, `redis-publish body: ${JSON.stringify(pubBody)}`);
}

async function testValidation() {
  console.log("\n── input validation ──");

  // Missing key header
  const r1 = await fetch(`${PROXY}/redis-getz`);
  assert(r1.status === 400, `redis-getz without key header → ${r1.status}`);

  // Invalid key (path traversal)
  const r2 = await fetch(`${PROXY}/redis-getz`, {
    headers: { "X-Redis-Key": "../../../etc/passwd" },
  });
  assert(r2.status === 400, `redis-getz with traversal key → ${r2.status}`);

  // Missing expire
  const r3 = await fetch(`${PROXY}/redis-setexz`, {
    method: "POST",
    headers: { "X-Redis-Key": "test" },
    body: "data",
  });
  assert(r3.status === 400, `redis-setexz without expire → ${r3.status}`);

  // Invalid expire (negative)
  const r4 = await fetch(`${PROXY}/redis-setexz`, {
    method: "POST",
    headers: { "X-Redis-Key": "test", "X-Redis-Expire": "-1" },
    body: "data",
  });
  assert(r4.status === 400, `redis-setexz with negative expire → ${r4.status}`);

  // Invalid expire (too large)
  const r5 = await fetch(`${PROXY}/redis-setexz`, {
    method: "POST",
    headers: { "X-Redis-Key": "test", "X-Redis-Expire": "9999999" },
    body: "data",
  });
  assert(r5.status === 400, `redis-setexz with huge expire → ${r5.status}`);

  // Unknown endpoint
  const r6 = await fetch(`${PROXY}/unknown-endpoint`, { method: "POST" });
  assert(r6.status === 404, `unknown endpoint → ${r6.status}`);

  // Key not found
  const r7 = await fetch(`${PROXY}/redis-getz`, {
    headers: { "X-Redis-Key": "nonexistent-key-that-does-not-exist-12345" },
  });
  assert(r7.status === 404, `redis-getz nonexistent key → ${r7.status}`);

  // redis-publish missing fields
  const r8 = await fetch(`${PROXY}/redis-publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "test" }),
  });
  assert(r8.status === 400, `redis-publish missing message → ${r8.status}`);

  // redis-publish with traversal channel
  const r9 = await fetch(`${PROXY}/redis-publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "../evil", message: "hi" }),
  });
  assert(r9.status === 400, `redis-publish traversal channel → ${r9.status}`);
}

async function testInjectionAttempts() {
  console.log("\n── injection attempts ──");

  const injectionKeys = [
    { key: "../../../etc/passwd", desc: "path traversal" },
    { key: "/absolute/path", desc: "absolute path" },
    { key: "key; rm -rf /", desc: "command injection semicolon" },
    { key: "key$(whoami)", desc: "command injection subshell" },
    { key: "key`id`", desc: "command injection backtick" },
    { key: "key\nSET evil 1", desc: "redis protocol injection (newline)" },
    { key: "key\r\nSET evil 1", desc: "redis protocol injection (CRLF)" },
    { key: "key && cat /etc/shadow", desc: "command injection &&" },
    { key: "key | cat /etc/shadow", desc: "command injection pipe" },
    { key: "", desc: "empty key" },
    { key: "a".repeat(300), desc: "key too long (300 chars)" },
  ];

  for (const { key, desc } of injectionKeys) {
    try {
      const r = await fetch(`${PROXY}/redis-getz`, {
        headers: { "X-Redis-Key": key },
      });
      assert(r.status === 400, `redis-getz rejects ${desc} → ${r.status}`);
    } catch {
      // fetch itself rejects invalid header values (e.g. newlines) — that's good
      assert(true, `redis-getz rejects ${desc} → fetch threw (header rejected)`);
    }
  }

  for (const { key, desc } of injectionKeys) {
    try {
      const r = await fetch(`${PROXY}/redis-setexz`, {
        method: "POST",
        headers: { "X-Redis-Key": key, "X-Redis-Expire": "60" },
        body: "data",
      });
      assert(r.status === 400, `redis-setexz rejects ${desc} → ${r.status}`);
    } catch {
      assert(true, `redis-setexz rejects ${desc} → fetch threw (header rejected)`);
    }
  }
}

async function testKeyWithSlashesAndDots() {
  console.log("\n── keys with slashes and dots ──");

  // ci3 uses keys like "claudebox/abc123-1" and "history_abc123"
  const slashKey = `claudebox/${TEST_KEY}`;
  const setRes = await fetch(`${PROXY}/redis-setexz`, {
    method: "POST",
    headers: {
      "X-Redis-Key": slashKey,
      "X-Redis-Expire": "60",
      "Content-Type": "application/octet-stream",
    },
    body: "slash key data",
  });
  assert(setRes.ok, `redis-setexz with slash key returned ${setRes.status}`);

  const getRes = await fetch(`${PROXY}/redis-getz`, {
    headers: { "X-Redis-Key": slashKey },
  });
  assert(getRes.ok, `redis-getz with slash key returned ${getRes.status}`);
}

async function cleanup() {
  console.log("\n── cleanup ──");
  // Delete test keys via a direct setex with 1s TTL
  for (const suffix of ["-raw", "-gz", ""]) {
    const key = suffix ? `${TEST_KEY}${suffix}` : `claudebox/${TEST_KEY}`;
    try {
      await fetch(`${PROXY}/redis-setexz`, {
        method: "POST",
        headers: { "X-Redis-Key": key, "X-Redis-Expire": "1" },
        body: "expiring",
      });
    } catch {}
  }
  console.log("  ✔ test keys set to expire in 1s");
}

async function main() {
  console.log("━━━ Cred-Proxy Integration Test ━━━");
  console.log(`AZTEC_MCP_SERVER = ${PROXY}`);

  await waitForSidecar();
  console.log("Sidecar ready.\n");

  await testRedisSetexzAndGetz();
  await testGzippedRoundtrip();
  await testRedisPublish();
  await testValidation();
  await testInjectionAttempts();
  await testKeyWithSlashesAndDots();
  await cleanup();

  console.log(`\n━━━ Results: ${passed} passed, ${failed} failed ━━━`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
