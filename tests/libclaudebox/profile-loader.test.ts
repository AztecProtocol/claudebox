import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";


import {
  setProfilesDir, discoverProfiles, loadProfile,
  getDockerConfig, buildChannelProfileMap, buildChannelBranchMap,
} from "../../packages/libclaudebox/profile-loader.ts";

const TEST_DIR = join(tmpdir(), `claudebox-test-profiles-${Date.now()}`);

function createProfile(name: string, opts?: {
  hasSidecar?: boolean;
  manifestContent?: string;
}) {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  if (opts?.hasSidecar !== false) {
    writeFileSync(join(dir, "mcp-sidecar.ts"), "// stub");
  }
  if (opts?.manifestContent) {
    writeFileSync(join(dir, "host-manifest.ts"), opts.manifestContent);
  }
}

describe("profile-loader", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Reset state by pointing to a fresh directory
    setProfilesDir(TEST_DIR);
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  describe("discoverProfiles", () => {
    it("discovers profiles with mcp-sidecar.ts", () => {
      createProfile("alpha");
      createProfile("beta");
      setProfilesDir(TEST_DIR); // reset cache
      const profiles = discoverProfiles();
      assert.ok(profiles.includes("alpha"));
      assert.ok(profiles.includes("beta"));
    });

    it("ignores directories without mcp-sidecar.ts", () => {
      createProfile("valid");
      createProfile("invalid", { hasSidecar: false });
      setProfilesDir(TEST_DIR);
      const profiles = discoverProfiles();
      assert.ok(profiles.includes("valid"));
      assert.ok(!profiles.includes("invalid"));
    });

    it("returns empty array for non-existent directory", () => {
      setProfilesDir("/tmp/does-not-exist-" + Date.now());
      assert.deepEqual(discoverProfiles(), []);
    });

    it("caches results", () => {
      createProfile("cached");
      setProfilesDir(TEST_DIR);
      const first = discoverProfiles();
      // Create another profile after first discovery
      createProfile("late");
      const second = discoverProfiles();
      // Should return cached results
      assert.deepEqual(first, second);
    });

    it("cache is cleared by setProfilesDir", () => {
      createProfile("first");
      setProfilesDir(TEST_DIR);
      discoverProfiles();
      createProfile("second");
      setProfilesDir(TEST_DIR); // clears cache
      const profiles = discoverProfiles();
      assert.ok(profiles.includes("second"));
    });
  });

  describe("loadProfile", () => {
    it("returns fallback for profile without host-manifest.ts", () => {
      createProfile("bare");
      setProfilesDir(TEST_DIR);
      return loadProfile("bare").then(manifest => {
        assert.equal(manifest.name, "bare");
        assert.equal(manifest.docker, undefined);
        assert.equal(manifest.channels, undefined);
      });
    });

    it("caches loaded profiles", async () => {
      createProfile("cacheable");
      setProfilesDir(TEST_DIR);
      const first = await loadProfile("cacheable");
      const second = await loadProfile("cacheable");
      assert.equal(first, second); // same reference
    });
  });

  describe("getDockerConfig", () => {
    it("returns empty config for profile without docker section", async () => {
      createProfile("nodock");
      setProfilesDir(TEST_DIR);
      const config = await getDockerConfig("nodock");
      assert.deepEqual(config, {});
    });
  });

  describe("buildChannelProfileMap", () => {
    it("returns empty map when no profiles have channels", async () => {
      createProfile("nochan");
      setProfilesDir(TEST_DIR);
      const map = await buildChannelProfileMap();
      assert.equal(map.size, 0);
    });
  });

  describe("buildChannelBranchMap", () => {
    it("returns empty map when no profiles have branch overrides", async () => {
      createProfile("nobranch");
      setProfilesDir(TEST_DIR);
      const map = await buildChannelBranchMap();
      assert.equal(map.size, 0);
    });
  });
});
