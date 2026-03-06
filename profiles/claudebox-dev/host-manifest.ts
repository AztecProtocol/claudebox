import type { ProfileManifest } from "../../packages/libclaudebox/profile-types.ts";

const manifest: ProfileManifest = {
  name: "claudebox-dev",
  docker: {
    mountReferenceRepo: false, // separate repo, uses authenticated URL clone
  },
};

export default manifest;
