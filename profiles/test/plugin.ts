import type { Plugin } from "../../packages/libclaudebox/plugin.ts";

const extraEnv: string[] = [];

// Only use mock-claude when explicitly requested (e2e tests set this)
if (process.env.CLAUDEBOX_USE_MOCK === "1") {
  extraEnv.push("CLAUDE_BINARY=/opt/claudebox/profiles/test/mock-claude.sh");
}

const plugin: Plugin = {
  name: "test",
  docker: {
    mountReferenceRepo: true,
    extraEnv,
  },
};

export default plugin;
