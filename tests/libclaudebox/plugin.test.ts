import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PluginRuntime, type Plugin, type SlackMessage } from "../../packages/libclaudebox/plugin.ts";

// Minimal stubs
const mockDocker = {} as any;
const mockStore = {} as any;

function makeMessage(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    channel: "C123",
    text: "hello",
    isReply: false,
    threadTs: "1234.5678",
    userId: "U123",
    userName: "testuser",
    client: {},
    respond: async () => {},
    ...overrides,
  };
}

describe("PluginRuntime", () => {
  let runtime: PluginRuntime;

  beforeEach(() => {
    runtime = new PluginRuntime(mockDocker, mockStore);
  });

  it("loads a plugin and makes it accessible", async () => {
    const plugin: Plugin = {
      name: "test-plugin",
      setup() {},
    };
    await runtime.loadPlugin(plugin);
    assert.equal(runtime.getPlugins().length, 1);
    assert.equal(runtime.getPlugins()[0].name, "test-plugin");
  });

  it("dispatches messages to registered handlers", async () => {
    const calls: string[] = [];
    const plugin: Plugin = {
      name: "test",
      setup(ctx) {
        ctx.onSlackMessage(async (msg) => {
          calls.push(msg.text);
          return true;
        });
      },
    };
    await runtime.loadPlugin(plugin);
    const claimed = await runtime.dispatchMessage(makeMessage({ text: "hi" }));
    assert.equal(claimed, true);
    assert.deepEqual(calls, ["hi"]);
  });

  it("stops dispatching after first handler claims", async () => {
    const calls: string[] = [];
    const plugin1: Plugin = {
      name: "first",
      setup(ctx) {
        ctx.onSlackMessage(async () => {
          calls.push("first");
          return true;
        });
      },
    };
    const plugin2: Plugin = {
      name: "second",
      setup(ctx) {
        ctx.onSlackMessage(async () => {
          calls.push("second");
          return true;
        });
      },
    };
    await runtime.loadPlugin(plugin1);
    await runtime.loadPlugin(plugin2);
    await runtime.dispatchMessage(makeMessage());
    assert.deepEqual(calls, ["first"]);
  });

  it("passes through to next handler when not claimed", async () => {
    const calls: string[] = [];
    const plugin1: Plugin = {
      name: "first",
      channels: ["C999"],
      setup(ctx) {
        ctx.onSlackMessage(async (msg) => {
          if (msg.channel !== "C999") return false;
          calls.push("first");
          return true;
        });
      },
    };
    const plugin2: Plugin = {
      name: "second",
      setup(ctx) {
        ctx.onSlackMessage(async () => {
          calls.push("second");
          return true;
        });
      },
    };
    await runtime.loadPlugin(plugin1);
    await runtime.loadPlugin(plugin2);
    await runtime.dispatchMessage(makeMessage({ channel: "C123" }));
    assert.deepEqual(calls, ["second"]);
  });

  it("collects routes from plugins", async () => {
    const plugin: Plugin = {
      name: "test",
      setup(ctx) {
        ctx.route("GET", "/coverage", async () => {}, "basic");
        ctx.route("POST", "/findings", async () => {}, "api");
      },
    };
    await runtime.loadPlugin(plugin);
    assert.equal(runtime.getRoutes().length, 2);
    assert.equal(runtime.getRoutes()[0].path, "/coverage");
    assert.equal(runtime.getRoutes()[1].path, "/findings");
  });

  it("dispatches reactions", async () => {
    const reactions: string[] = [];
    const p: Plugin = {
      name: "test",
      setup(ctx) {
        ctx.onSlackReaction(async (r) => {
          reactions.push(r.reaction);
          return true;
        });
      },
    };
    await runtime.loadPlugin(p);
    const claimed = await runtime.dispatchReaction({
      reaction: "thumbsup",
      channel: "C123",
      messageTs: "1234.5678",
      userId: "U123",
      client: {},
    });
    assert.equal(claimed, true);
    assert.deepEqual(reactions, ["thumbsup"]);
  });

  it("returns false when no handler claims message", async () => {
    const p: Plugin = {
      name: "picky",
      setup(ctx) {
        ctx.onSlackMessage(async () => false);
      },
    };
    await runtime.loadPlugin(p);
    const claimed = await runtime.dispatchMessage(makeMessage());
    assert.equal(claimed, false);
  });
});
