import type { ProfileManifest } from "../../packages/libclaudebox/profile-types.ts";

const manifest: ProfileManifest = {
  name: "barretenberg-audit",
  docker: {
    mountReferenceRepo: false,
    extraEnv: ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"],
  },
  channels: ["C0AJCUKUNGP"],
  requiresServer: true,
};

export default manifest;
