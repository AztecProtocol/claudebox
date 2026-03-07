#!/usr/bin/env bash
# Manual test: verify claude -p works with haiku, and that the CLI + plugin system works.
# Run from repo root: bash tests/manual/test-claude-haiku.sh

set -uo pipefail

OUTDIR=$(mktemp -d)
trap 'rm -rf "$OUTDIR"' EXIT

pass=0
fail=0

check() {
  local name="$1" result="$2"
  if [ "$result" = "ok" ]; then
    echo "  PASS  $name"
    ((pass++))
  else
    echo "  FAIL  $name"
    ((fail++))
  fi
}

echo "=== ClaudeBox Test Suite (manual, uses real claude -p with haiku) ==="
echo ""

# ── 1. claude -p basic smoke test ──────────────────────────────
echo "── 1. claude -p with haiku ──"
if [ -n "${CLAUDECODE:-}" ]; then
  echo "  SKIP  claude -p (cannot nest inside Claude Code session)"
else
  timeout 30 claude -p --model claude-haiku-4-5-20251001 \
    "Reply with exactly the word PONG and nothing else" \
    > "$OUTDIR/haiku-out.txt" 2>"$OUTDIR/haiku-err.txt" || true

  HAIKU_OUT=$(cat "$OUTDIR/haiku-out.txt")
  echo "  Output: $HAIKU_OUT"
  if echo "$HAIKU_OUT" | grep -qi "PONG"; then
    check "haiku responds" "ok"
  else
    check "haiku responds (may need to run outside Claude Code)" "fail"
  fi
fi

# ── 2. CLI help output ────────────────────────────────────────
echo ""
echo "── 2. CLI commands ──"

node --experimental-strip-types --no-warnings cli.ts --help > "$OUTDIR/cli-help.txt" 2>&1 || true
if grep -q "claudebox run" "$OUTDIR/cli-help.txt"; then
  check "cli help shows run" "ok"
else
  check "cli help shows run" "fail"
fi
if grep -q "claudebox resume" "$OUTDIR/cli-help.txt"; then
  check "cli help shows resume" "ok"
else
  check "cli help shows resume" "fail"
fi
if grep -q "claudebox sessions" "$OUTDIR/cli-help.txt"; then
  check "cli help shows sessions" "ok"
else
  check "cli help shows sessions" "fail"
fi
if grep -q "claudebox logs" "$OUTDIR/cli-help.txt"; then
  check "cli help shows logs" "ok"
else
  check "cli help shows logs" "fail"
fi
if grep -q "claudebox config" "$OUTDIR/cli-help.txt"; then
  check "cli help shows config" "ok"
else
  check "cli help shows config" "fail"
fi

node --experimental-strip-types --no-warnings cli.ts run --help > "$OUTDIR/run-help.txt" 2>&1 || true
if grep -q "\-\-follow" "$OUTDIR/run-help.txt"; then
  check "run --help shows --follow" "ok"
else
  check "run --help shows --follow" "fail"
fi

node --experimental-strip-types --no-warnings cli.ts resume --help > "$OUTDIR/resume-help.txt" 2>&1 || true
if grep -q "worktree-id" "$OUTDIR/resume-help.txt"; then
  check "resume --help shows worktree-id" "ok"
else
  check "resume --help shows worktree-id" "fail"
fi

# ── 3. Plugin system ─────────────────────────────────────────
echo ""
echo "── 3. Plugin system ──"

CLAUDEBOX_SESSION_PASS=test node --experimental-strip-types --no-warnings cli.ts profiles \
  > "$OUTDIR/profiles.txt" 2>&1 || true

if grep -q "barretenberg-audit" "$OUTDIR/profiles.txt"; then
  check "discovers barretenberg-audit" "ok"
else
  check "discovers barretenberg-audit" "fail"
fi
if grep -q "requires-server" "$OUTDIR/profiles.txt"; then
  check "barretenberg-audit shows requires-server" "ok"
else
  check "barretenberg-audit shows requires-server" "fail"
fi
if grep -q "default" "$OUTDIR/profiles.txt"; then
  check "discovers default profile" "ok"
else
  check "discovers default profile" "fail"
fi
if grep -q "claudebox-dev" "$OUTDIR/profiles.txt"; then
  check "discovers claudebox-dev" "ok"
else
  check "discovers claudebox-dev" "fail"
fi

# ── 4. Plugin loader + runtime unit check ─────────────────────
echo ""
echo "── 4. Plugin runtime ──"

CLAUDEBOX_SESSION_PASS=test node --experimental-strip-types --no-warnings -e "
import { setPluginsDir, loadPlugin } from './packages/libclaudebox/plugin-loader.ts';
import { PluginRuntime } from './packages/libclaudebox/plugin.ts';
import { resolve } from 'path';

setPluginsDir(resolve('profiles'));
const plugin = await loadPlugin('barretenberg-audit');

if (plugin.name !== 'barretenberg-audit') throw new Error('wrong name');
if (plugin.docker?.mountReferenceRepo !== false) throw new Error('docker config wrong');
if (!plugin.channels?.includes('C0AJCUKUNGP')) throw new Error('missing channel');
if (!plugin.requiresServer) throw new Error('should require server');

const runtime = new PluginRuntime({} as any, { findByWorktreeId: () => null, isWorktreeAlive: () => false } as any);
await runtime.loadPlugin(plugin);

const routes = runtime.getRoutes();
if (routes.length !== 7) throw new Error('expected 7 routes, got ' + routes.length);

const paths = routes.map(r => r.method + ' ' + r.path);
const expected = [
  'GET /audit',
  'GET /api/audit/questions',
  'GET /api/audit/findings',
  'GET /api/audit/assessments',
  'GET /api/audit/coverage',
  'POST /api/audit/questions/:id/answer',
  'POST /api/audit/questions/direction',
];
for (const e of expected) {
  if (!paths.includes(e)) throw new Error('missing route: ' + e);
}

// Test channel map
const chMap = runtime.buildChannelProfileMap();
if (chMap.get('C0AJCUKUNGP') !== 'barretenberg-audit') throw new Error('channel map wrong');

console.log('ALL_OK');
" > "$OUTDIR/plugin-runtime.txt" 2>&1 || true

if grep -q "ALL_OK" "$OUTDIR/plugin-runtime.txt"; then
  check "plugin runtime loads barretenberg-audit with 7 routes" "ok"
else
  check "plugin runtime loads barretenberg-audit with 7 routes" "fail"
  cat "$OUTDIR/plugin-runtime.txt"
fi

# ── 5. Node test runner ───────────────────────────────────────
echo ""
echo "── 5. Node test suite ──"

npm test > "$OUTDIR/npm-test.txt" 2>&1 || true
TEST_RESULT=$(tail -10 "$OUTDIR/npm-test.txt")
PASS_COUNT=$(echo "$TEST_RESULT" | grep -oP 'pass \K\d+' || echo "0")
FAIL_COUNT=$(echo "$TEST_RESULT" | grep -oP 'fail \K\d+' || echo "0")
echo "  npm test: $PASS_COUNT passed, $FAIL_COUNT failed"
if [ "$FAIL_COUNT" = "0" ] && [ "$PASS_COUNT" -gt 0 ]; then
  check "npm test all pass" "ok"
else
  check "npm test all pass" "fail"
fi

# ── 6. Config command ────────────────────────────────────────
echo ""
echo "── 6. Config command ──"

# Use a temp config dir
ORIG_HOME="$HOME"
export HOME="$OUTDIR/fakehome"
mkdir -p "$HOME/.claudebox"

node --experimental-strip-types --no-warnings cli.ts config server https://test.example.com \
  > "$OUTDIR/config-set.txt" 2>&1 || true
if grep -q "Set server" "$OUTDIR/config-set.txt"; then
  check "config set server" "ok"
else
  check "config set server" "fail"
fi

node --experimental-strip-types --no-warnings cli.ts config server \
  > "$OUTDIR/config-get.txt" 2>&1 || true
if grep -q "https://test.example.com" "$OUTDIR/config-get.txt"; then
  check "config get server" "ok"
else
  check "config get server" "fail"
fi

export HOME="$ORIG_HOME"

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  PASS: $pass   FAIL: $fail"
echo "═══════════════════════════════════════"

[ "$fail" -eq 0 ] && exit 0 || exit 1
