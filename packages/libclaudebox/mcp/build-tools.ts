/**
 * Build tool registration for MCP sidecars.
 *
 * Provides `build`, `build_cpp`, and `run_test` tools for building
 * aztec-packages via Makefile (next+) or bootstrap.sh fallback (v4).
 */

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sanitizeError } from "./helpers.ts";

// ── Helpers ─────────────────────────────────────────────────────

const MAX_OUTPUT = 100_000;
const BUILD_TIMEOUT = 600_000;   // 10 min
const CONFIGURE_TIMEOUT = 120_000; // 2 min

/** Run a command asynchronously, capturing output. */
function runCmd(cmd: string, args: string[], cwd: string, timeoutMs = BUILD_TIMEOUT): Promise<{ ok: boolean; code: number | null; text: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));

    child.on("close", (code) => {
      clearTimeout(timer);
      let text = chunks.join("").trim();
      if (text.length > MAX_OUTPUT)
        text = text.slice(0, MAX_OUTPUT) + "\n\n...(truncated — use write_log for full output)";
      text = sanitizeError(text);
      resolve({ ok: code === 0, code, text });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, text: sanitizeError(err.message) });
    });
  });
}

/** Resolve cmake build directory for a preset by walking CMakePresets.json inheritance. */
function resolveBuildDir(cppDir: string, preset: string): string {
  try {
    const presets = JSON.parse(readFileSync(join(cppDir, "CMakePresets.json"), "utf-8"));
    const find = (name: string): any => presets.configurePresets?.find((p: any) => p.name === name);
    let p = find(preset);
    while (p) {
      if (p.binaryDir) return join(cppDir, p.binaryDir.replace("${sourceDir}/", ""));
      p = p.inherits ? find(Array.isArray(p.inherits) ? p.inherits[0] : p.inherits) : null;
    }
  } catch {}
  return join(cppDir, "build");
}

// ── Target → bootstrap.sh fallback (branches without Makefile) ──
// Each entry: [projectPath] or [projectPath, bootstrapFunction]

const BOOTSTRAP_TARGETS: Record<string, [string] | [string, string]> = {
  "yarn-project":            ["yarn-project"],
  "noir":                    ["noir"],
  "l1-contracts":            ["l1-contracts"],
  "l1-contracts-src":        ["l1-contracts", "build_src"],
  "l1-contracts-verifier":   ["l1-contracts", "build_verifier"],
  "noir-projects":           ["noir-projects"],
  "noir-protocol-circuits":  ["noir-projects/noir-protocol-circuits"],
  "noir-contracts":          ["noir-projects/noir-contracts"],
  "mock-protocol-circuits":  ["noir-projects/mock-protocol-circuits"],
  "aztec-nr":                ["noir-projects/aztec-nr"],
  "avm-transpiler-native":   ["avm-transpiler", "build_native"],
  "bb-cpp-native":           ["barretenberg/cpp", "build_native"],
  "bb-cpp-native-objects":   ["barretenberg/cpp", "build_native_objects"],
  "bb-cpp-wasm":             ["barretenberg/cpp", "build_wasm"],
  "bb-cpp-wasm-threads":     ["barretenberg/cpp", "build_wasm_threads"],
  "bb-ts":                   ["barretenberg/ts"],
  "bb-rs":                   ["barretenberg/rust"],
  "bb-sol":                  ["barretenberg/sol"],
  "bb-crs":                  ["barretenberg/crs"],
  "bb-bbup":                 ["barretenberg/bbup"],
  "bb-docs":                 ["barretenberg/docs"],
  "bb-acir":                 ["barretenberg/acir_tests"],
  "barretenberg":            ["barretenberg"],
  "boxes":                   ["boxes"],
  "playground":              ["playground"],
  "docs":                    ["docs"],
  "release-image":           ["release-image"],
  "aztec-up":                ["aztec-up"],
};

// ── Tool registration ───────────────────────────────────────────

export interface BuildToolConfig {
  workspace: string;
  /** Path to a repo checkout that has yarn-project/node_modules installed (for prettier). */
  referenceRepo?: string;
}

/** Format changed files only. Exported so PR hooks can call it. */
export async function formatChangedFiles(ws: string, referenceRepo?: string): Promise<{ ok: boolean; text: string }> {
  const results: string[] = [];

  // Detect which areas have changes
  const diff = await runCmd("git", ["diff", "--name-only", "HEAD"], ws, 10_000);
  const staged = await runCmd("git", ["diff", "--name-only", "--cached"], ws, 10_000);
  const allFiles = (diff.text + "\n" + staged.text).trim();
  if (!allFiles) return { ok: true, text: "No changed files to format." };

  const files = allFiles.split("\n").filter(Boolean);
  const hasYarnProject = files.some(f => f.startsWith("yarn-project/"));
  const hasBarretenberg = files.some(f => f.startsWith("barretenberg/cpp/"));

  // ── yarn-project: prettier ──
  if (hasYarnProject) {
    const tsFiles = files
      .filter(f => f.startsWith("yarn-project/") && /\.(ts|js|mjs|cjs|json)$/.test(f))
      .map(f => join(ws, f))
      .filter(f => existsSync(f));
    if (tsFiles.length > 0) {
      // Use prettier from the reference repo (has node_modules installed)
      const prettierBase = referenceRepo || ws;
      const prettierBin = join(prettierBase, "yarn-project/node_modules/.bin/prettier");
      if (existsSync(prettierBin)) {
        // Resolve config from reference repo so plugins are found relative to it
        const configFile = join(prettierBase, "yarn-project/foundation/.prettierrc.json");
        const args = ["--log-level", "warn", "-w"];
        if (existsSync(configFile)) args.push("--config", configFile);
        args.push(...tsFiles);
        const r = await runCmd(prettierBin, args, ws, 120_000);
        results.push(r.ok
          ? `yarn-project: formatted ${tsFiles.length} files`
          : `yarn-project: prettier failed (exit ${r.code}): ${r.text.slice(0, 300)}`);
      } else {
        results.push(`yarn-project: prettier not found at ${prettierBin}, skipping`);
      }
    }
  }

  // ── barretenberg: clang-format ──
  if (hasBarretenberg) {
    const cppFiles = files
      .filter(f => f.startsWith("barretenberg/cpp/") && /\.(cpp|hpp|tcc)$/.test(f))
      .map(f => join(ws, f))
      .filter(f => existsSync(f));
    if (cppFiles.length > 0) {
      const formatSh = join(ws, "barretenberg/cpp/format.sh");
      if (existsSync(formatSh)) {
        const r = await runCmd(formatSh, ["changed"], join(ws, "barretenberg/cpp"), 120_000);
        results.push(r.ok
          ? `barretenberg: formatted ${cppFiles.length} C++ files`
          : `barretenberg: format.sh failed (exit ${r.code}): ${r.text.slice(0, 300)}`);
      } else {
        results.push("barretenberg: format.sh not found, skipping");
      }
    }
  }

  if (results.length === 0) return { ok: true, text: "No formattable files changed." };
  return { ok: true, text: results.join("\n") };
}

export function registerBuildTools(server: McpServer, config: BuildToolConfig): void {
  const ws = config.workspace;

  // ── build ─────────────────────────────────────────────────────
  server.tool("build",
    `Build a project. Uses 'make <target>' when available, falls back to bootstrap.sh on older branches (v4).

IMPORTANT: Run submodule_update() before your first build — most targets depend on submodules (noir/noir-repo, l1-contracts/lib/*, etc.).

Aggregate targets:
  fast             — Full default build (barretenberg + boxes + playground + docs + aztec-up + all tests)
  full             — fast + bb-full-tests + bb-cpp-full + yarn-project-benches
  release          — fast + cross-compiled bb binaries

Barretenberg C++ targets:
  bb-cpp-native        — Native build (bb + bb-avm binaries)
  bb-cpp-native-objects — Just compile objects (no link)
  bb-cpp-wasm          — WASM single-threaded build
  bb-cpp-wasm-threads  — WASM multi-threaded build
  bb-cpp               — All of: native + wasm + wasm-threads
  bb-cpp-full          — native + wasm + wasm-threads + gcc + smt + fuzzing
  bb-cpp-asan          — Address sanitizer build
  bb-cpp-gcc           — GCC build
  bb-cpp-smt           — SMT solver build
  bb-cpp-fuzzing       — Fuzzing build
  bb-cpp-release-dir   — Release directory layout
  bb-cpp-cross-*       — Cross-compilation (amd64-macos, arm64-macos, arm64-linux, arm64-android, etc.)

Barretenberg other:
  barretenberg     — All BB sub-projects (cpp + ts + rs + acir + docs + sol + bbup + crs)
  bb-ts            — TypeScript bindings
  bb-rs            — Rust bindings
  bb-sol           — Solidity verifier
  bb-acir          — ACIR tests
  bb-docs          — BB documentation
  bb-crs          — Common reference string
  bb-bbup          — BB version manager

Noir:
  noir             — Noir compiler
  noir-projects    — All Noir circuits (protocol + contracts + mock + aztec-nr)
  noir-protocol-circuits — Protocol circuits only
  noir-contracts   — Contract circuits only
  mock-protocol-circuits — Mock circuits
  aztec-nr         — Aztec Noir library

Other projects:
  yarn-project     — TS packages (depends on bb-ts, noir-projects, l1-contracts)
  l1-contracts     — L1 Ethereum contracts (full)
  l1-contracts-src — L1 contracts source only (fast, no deps)
  l1-contracts-verifier — Verifier contract only
  avm-transpiler-native — AVM transpiler native build
  playground       — Playground app (produces dist/)
  boxes            — Starter boxes
  docs             — Documentation site
  release-image    — Docker release image
  aztec-up         — aztec-up installer

Test targets (output test commands, don't run them):
  bb-tests, bb-full-tests, bb-cpp-native-tests, bb-cpp-asan-tests, bb-cpp-smt-tests,
  bb-cpp-wasm-threads-tests, bb-cpp-wasm-threads-benches, bb-ts-tests, bb-rs-tests,
  bb-sol-tests, bb-acir-tests, bb-bbup-tests, bb-docs-tests,
  yarn-project-tests, yarn-project-benches, l1-contracts-tests,
  boxes-tests, playground-tests, docs-tests, aztec-up-tests,
  noir-protocol-circuits-tests, noir-projects-txe-tests, release-image-tests

Use 'build_cpp' for building individual C++ cmake targets (faster for single binaries/tests).`,
    {
      target: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Build target"),
      jobs: z.number().optional().describe("Parallel jobs (-jN)"),
    },
    async ({ target, jobs }) => {
      if (!existsSync(join(ws, ".git")))
        return { content: [{ type: "text", text: `No repo at ${ws}. Run clone_repo first.` }], isError: true };

      // Prefer Makefile (next branch+), fall back to bootstrap.sh (v4)
      if (!existsSync(join(ws, "Makefile"))) {
        const entry = BOOTSTRAP_TARGETS[target];
        if (!entry) {
          const known = Object.keys(BOOTSTRAP_TARGETS).join(", ");
          return { content: [{ type: "text", text: `No Makefile and no bootstrap mapping for '${target}'. Known: ${known}` }], isError: true };
        }
        const [project, func] = entry;
        const dir = join(ws, project);
        if (!existsSync(join(dir, "bootstrap.sh")))
          return { content: [{ type: "text", text: `No bootstrap.sh at ${project}` }], isError: true };

        const r = await runCmd("./bootstrap.sh", func ? [func] : [], dir);
        return r.ok
          ? { content: [{ type: "text", text: `Build '${target}' via ${project}/bootstrap.sh ${func || ""} succeeded.\n${r.text}` }] }
          : { content: [{ type: "text", text: `${project}/bootstrap.sh ${func || ""} failed (exit ${r.code}):\n${r.text}` }], isError: true };
      }

      const args = jobs ? [`-j${jobs}`, target] : [target];
      const r = await runCmd("make", args, ws);
      return r.ok
        ? { content: [{ type: "text", text: `Build '${target}' succeeded.\n${r.text}` }] }
        : { content: [{ type: "text", text: `Build '${target}' failed (exit ${r.code}):\n${r.text}` }], isError: true };
    });

  // ── build_cpp ─────────────────────────────────────────────────
  server.tool("build_cpp",
    `Build a single C++ cmake target in barretenberg/cpp. Faster than 'build bb-cpp-native'.
Auto-configures cmake on first run.

Targets:       bb, bb-avm, <module>_tests (e.g. ultra_honk_tests), barretenberg, bb-external
Presets:       clang20 (default), clang20-no-avm, debug, debug-fast, asan-fast`,
    {
      target: z.string().regex(/^[a-zA-Z0-9_.-]+$/).describe("CMake target (e.g. 'bb', 'ultra_honk_tests')"),
      preset: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("clang20").describe("CMake preset"),
      jobs: z.number().optional().describe("Parallel jobs"),
    },
    async ({ target, preset, jobs }) => {
      if (!existsSync(join(ws, ".git")))
        return { content: [{ type: "text", text: `No repo at ${ws}. Run clone_repo first.` }], isError: true };

      const cppDir = join(ws, "barretenberg/cpp");
      if (!existsSync(cppDir))
        return { content: [{ type: "text", text: "barretenberg/cpp not found" }], isError: true };

      const buildDir = resolveBuildDir(cppDir, preset);

      // Configure if no build system generated yet
      if (!existsSync(join(buildDir, "build.ninja")) && !existsSync(join(buildDir, "Makefile"))) {
        const cfg = await runCmd("cmake", ["--preset", preset], cppDir, CONFIGURE_TIMEOUT);
        if (!cfg.ok)
          return { content: [{ type: "text", text: `cmake configure failed:\n${cfg.text}` }], isError: true };
      }

      const args = ["--build", "--preset", preset, "--target", target];
      if (jobs) args.push("-j", String(jobs));

      const r = await runCmd("cmake", args, cppDir);
      if (!r.ok)
        return { content: [{ type: "text", text: `build_cpp '${target}' failed (exit ${r.code}):\n${r.text}` }], isError: true };

      const bin = join(buildDir, "bin", target);
      const loc = existsSync(bin) ? `\nBinary: ${bin}` : "";
      return { content: [{ type: "text", text: `build_cpp '${target}' (${preset}) succeeded.${loc}\n${r.text}` }] };
    });

  // ── run_test ──────────────────────────────────────────────────
  server.tool("run_test",
    `Run a C++ test binary. Build it first with build_cpp.
Example: run_test(binary="ultra_honk_tests", filter="*Basic*")`,
    {
      binary: z.string().regex(/^[a-zA-Z0-9_.-]+$/).describe("Test binary name"),
      filter: z.string().optional().describe("GTest filter (e.g. '*Merkle*')"),
      preset: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("clang20").describe("Preset used to build"),
    },
    async ({ binary, filter, preset }) => {
      if (!existsSync(join(ws, ".git")))
        return { content: [{ type: "text", text: `No repo at ${ws}. Run clone_repo first.` }], isError: true };

      const buildDir = resolveBuildDir(join(ws, "barretenberg/cpp"), preset);
      const bin = join(buildDir, "bin", binary);
      if (!existsSync(bin))
        return { content: [{ type: "text", text: `Not found: ${bin}\nBuild first: build_cpp(target="${binary}")` }], isError: true };

      const args = filter ? [`--gtest_filter=${filter}`] : [];
      const r = await runCmd(bin, args, buildDir);
      return r.ok
        ? { content: [{ type: "text", text: `Test '${binary}' passed.\n${r.text}` }] }
        : { content: [{ type: "text", text: `Test '${binary}' failed (exit ${r.code}):\n${r.text}` }], isError: true };
    });

  // ── yarn_project_format ────────────────────────────────────────
  server.tool("yarn_project_format",
    `Format yarn-project TypeScript/JavaScript files with prettier.
Formats only changed files by default, or specific packages if listed.`,
    {
      packages: z.array(z.string()).optional().describe("Specific packages to format (e.g. ['aztec.js', 'sequencer-client']). Omit to format all changed files."),
    },
    async ({ packages }) => {
      if (!existsSync(join(ws, ".git")))
        return { content: [{ type: "text", text: `No repo at ${ws}. Run clone_repo first.` }], isError: true };

      const ypDir = join(ws, "yarn-project");
      if (!existsSync(ypDir))
        return { content: [{ type: "text", text: "yarn-project/ not found" }], isError: true };

      const prettierBase = config.referenceRepo || ws;
      const prettierBin = join(prettierBase, "yarn-project/node_modules/.bin/prettier");
      if (!existsSync(prettierBin))
        return { content: [{ type: "text", text: `prettier not found at ${prettierBin}. Reference repo may not have node_modules installed.` }], isError: true };

      let files: string[];
      if (packages && packages.length > 0) {
        // Format specific packages — find all formattable files
        const findArgs = packages.flatMap(p => [join(ypDir, p, "src")]).filter(d => existsSync(d));
        if (findArgs.length === 0)
          return { content: [{ type: "text", text: `None of the specified packages have a src/ directory` }], isError: true };
        const found = await runCmd("find", [...findArgs, "-type", "f", "-regex", ".*\\.\\(json\\|js\\|mjs\\|cjs\\|ts\\)$"], ws, 30_000);
        files = found.text.split("\n").filter(Boolean);
      } else {
        // Format only changed files
        const diff = await runCmd("git", ["diff", "--name-only", "HEAD"], ws, 10_000);
        files = diff.text.split("\n")
          .filter(f => f.startsWith("yarn-project/") && /\.(ts|js|mjs|cjs|json)$/.test(f))
          .map(f => join(ws, f))
          .filter(f => existsSync(f));
      }

      if (files.length === 0)
        return { content: [{ type: "text", text: "No files to format." }] };

      const configFile = join(prettierBase, "yarn-project/foundation/.prettierrc.json");
      const args = ["--log-level", "warn", "-w"];
      if (existsSync(configFile)) args.push("--config", configFile);
      args.push(...files);
      const r = await runCmd(prettierBin, args, ws, 120_000);
      return r.ok
        ? { content: [{ type: "text", text: `Formatted ${files.length} files.\n${r.text}` }] }
        : { content: [{ type: "text", text: `prettier failed (exit ${r.code}):\n${r.text}` }], isError: true };
    });

  // ── barretenberg_format ────────────────────────────────────────
  server.tool("barretenberg_format",
    `Format barretenberg C++ files with clang-format.
Formats changed files by default using barretenberg/cpp/format.sh.`,
    {
      mode: z.enum(["changed", "staged", "check"]).default("changed")
        .describe("'changed' = format changed files, 'staged' = format staged files, 'check' = dry-run check"),
    },
    async ({ mode }) => {
      if (!existsSync(join(ws, ".git")))
        return { content: [{ type: "text", text: `No repo at ${ws}. Run clone_repo first.` }], isError: true };

      const cppDir = join(ws, "barretenberg/cpp");
      const formatSh = join(cppDir, "format.sh");
      if (!existsSync(formatSh))
        return { content: [{ type: "text", text: "barretenberg/cpp/format.sh not found" }], isError: true };

      const r = await runCmd("./format.sh", [mode], cppDir, 120_000);
      return r.ok
        ? { content: [{ type: "text", text: `barretenberg format (${mode}) succeeded.\n${r.text}` }] }
        : { content: [{ type: "text", text: `barretenberg format (${mode}) failed (exit ${r.code}):\n${r.text}` }], isError: true };
    });
}
