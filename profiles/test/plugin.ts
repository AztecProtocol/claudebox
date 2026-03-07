import type { Plugin } from "../../packages/libclaudebox/plugin.ts";

const plugin: Plugin = {
  name: "test",
  docker: {
    mountReferenceRepo: true,
    extraEnv: [
      // Override claude binary with mock script (mounted via /opt/claudebox)
      "CLAUDE_BINARY=/opt/claudebox/profiles/test/mock-claude.sh",
    ],
  },
};

export default plugin;
