import type { Plugin } from "../../packages/libclaudebox/plugin.ts";

const plugin: Plugin = {
  name: "claudebox-dev",
  docker: { mountReferenceRepo: false },
  setup(_ctx) {},
};

export default plugin;
