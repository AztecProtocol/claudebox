import type { Profile } from "../../packages/libclaudebox/profile.ts";

const plugin: Profile = {
  name: "minimal",
  docker: { mountReferenceRepo: false },
  setup(_ctx) {},
};

export default plugin;
