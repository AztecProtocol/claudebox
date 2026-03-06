import type { ProfileManifest } from "../../packages/libclaudebox/profile-types.ts";

const manifest: ProfileManifest = {
  name: "claudebox-dev",
  docker: {
    mountReferenceRepo: true,
  },
};

export default manifest;
