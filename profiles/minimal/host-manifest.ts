import type { ProfileManifest } from "../../packages/libclaudebox/profile-types.ts";

const manifest: ProfileManifest = {
  name: "minimal",
  docker: {
    mountReferenceRepo: false,
  },
};

export default manifest;
