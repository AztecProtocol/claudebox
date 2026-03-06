import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";


import { setChannelMaps } from "../../packages/libclaudebox/config.ts";
import { resolveBaseBranch, resolveQuietMode, resolveChannelName, toTargetRef } from "../../packages/libclaudebox/base-branch.ts";

// Mock Slack client
function mockClient(channels: Record<string, { name: string; num_members: number }>) {
  return {
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        const ch = channels[channel];
        if (!ch) throw new Error("channel_not_found");
        return { channel: ch };
      },
    },
  };
}

describe("base-branch", () => {
  beforeEach(() => {
    setChannelMaps(
      { "honk-team": "merge-train/barretenberg", "team-crypto": "merge-train/barretenberg" },
      {},
    );
  });

  describe("resolveChannelName", () => {
    it("resolves channel ID to name", async () => {
      const client = mockClient({ C123: { name: "general", num_members: 50 } });
      assert.equal(await resolveChannelName(client, "C123"), "general");
    });

    it("returns empty string for unknown channel", async () => {
      const client = mockClient({});
      assert.equal(await resolveChannelName(client, "C999"), "");
    });

    it("caches results", async () => {
      let calls = 0;
      const client = {
        conversations: {
          info: async () => { calls++; return { channel: { name: "cached", num_members: 10 } }; },
        },
      };
      await resolveChannelName(client, "CCACHE1");
      await resolveChannelName(client, "CCACHE1");
      assert.equal(calls, 1);
    });
  });

  describe("resolveBaseBranch", () => {
    it("returns configured branch for known channel", async () => {
      const client = mockClient({ CBRANCH1: { name: "honk-team", num_members: 20 } });
      assert.equal(await resolveBaseBranch(client, "CBRANCH1"), "merge-train/barretenberg");
    });

    it("returns default branch for unknown channel", async () => {
      const client = mockClient({ CBRANCH2: { name: "random", num_members: 100 } });
      assert.equal(await resolveBaseBranch(client, "CBRANCH2"), "main");
    });
  });

  describe("resolveQuietMode", () => {
    const client = mockClient({});

    it("honors explicit true", async () => {
      assert.equal(await resolveQuietMode(client, "C123", true), true);
    });

    it("honors explicit false", async () => {
      assert.equal(await resolveQuietMode(client, "C123", false), false);
    });

    it("auto-detects: channels are quiet", async () => {
      assert.equal(await resolveQuietMode(client, "C123", null), true);
    });

    it("auto-detects: DMs are verbose", async () => {
      assert.equal(await resolveQuietMode(client, "D123", null), false);
    });
  });

  describe("toTargetRef", () => {
    it("adds origin/ prefix", () => {
      assert.equal(toTargetRef("main"), "origin/main");
      assert.equal(toTargetRef("merge-train/barretenberg"), "origin/merge-train/barretenberg");
    });
  });
});
