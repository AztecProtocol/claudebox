import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setPluginsDir, discoverPlugins, loadPlugin, loadAllPlugins } from "../../packages/libclaudebox/plugin-loader.ts";

const TEST_DIR = join(tmpdir(), `claudebox-plugin-test-${Date.now()}`);

describe("plugin-loader", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setPluginsDir(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("discovers profiles with mcp-sidecar.ts", () => {
    mkdirSync(join(TEST_DIR, "alpha"));
    writeFileSync(join(TEST_DIR, "alpha", "mcp-sidecar.ts"), "// sidecar");
    mkdirSync(join(TEST_DIR, "beta"));
    // beta has no sidecar — should not be discovered
    const names = discoverPlugins();
    assert.deepEqual(names, ["alpha"]);
  });

  it("discovers profiles with plugin.ts", () => {
    mkdirSync(join(TEST_DIR, "gamma"));
    writeFileSync(join(TEST_DIR, "gamma", "plugin.ts"), "export default { name: 'gamma', setup() {} };");
    const names = discoverPlugins();
    assert.deepEqual(names, ["gamma"]);
  });

  it("loads fallback plugin for bare directory with sidecar", async () => {
    mkdirSync(join(TEST_DIR, "bare"));
    writeFileSync(join(TEST_DIR, "bare", "mcp-sidecar.ts"), "// sidecar");
    const plugin = await loadPlugin("bare");
    assert.equal(plugin.name, "bare");
  });

  it("loads legacy host-manifest as plugin shim", async () => {
    mkdirSync(join(TEST_DIR, "legacy"));
    writeFileSync(join(TEST_DIR, "legacy", "mcp-sidecar.ts"), "// sidecar");
    writeFileSync(join(TEST_DIR, "legacy", "host-manifest.ts"), `
      export default {
        name: "legacy",
        docker: { mountReferenceRepo: false },
        channels: ["C123"],
        branchOverrides: { "C123": "develop" },
      };
    `);
    const plugin = await loadPlugin("legacy");
    assert.equal(plugin.name, "legacy");
    assert.equal(plugin.docker?.mountReferenceRepo, false);
    assert.deepEqual(plugin.channels, ["C123"]);
    assert.deepEqual(plugin.branchOverrides, { "C123": "develop" });
  });

  it("returns empty list for nonexistent dir", () => {
    setPluginsDir("/tmp/nonexistent-" + Date.now());
    assert.deepEqual(discoverPlugins(), []);
  });
});
