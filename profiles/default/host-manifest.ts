import type { ProfileManifest } from "../../packages/libclaudebox/profile-types.ts";

const manifest: ProfileManifest = {
  name: "default",
  docker: {
    mountReferenceRepo: true,
  },
  branchOverrides: {
    "honk-team": "merge-train/barretenberg",
    "team-crypto": "merge-train/barretenberg",
    "team-alpha": "merge-train/spartan",
  },
};

export default manifest;
