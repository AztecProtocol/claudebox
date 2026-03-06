import type { ProfileManifest } from "../../packages/libclaudebox/profile-types.ts";

const manifest: ProfileManifest = {
  name: "barretenberg-audit",
  docker: {
    mountReferenceRepo: false,
  },
  channels: ["C0AJCUKUNGP"],
  requiresServer: true,
};

export default manifest;
