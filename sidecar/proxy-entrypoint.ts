import { startRedisProxy } from "./redis-proxy.ts";
import { startHttpProxy } from "./http-proxy.ts";

startRedisProxy({
  proxyPort: parseInt(process.env.REDIS_PROXY_PORT || "6379"),
  upstreamHost: process.env.REDIS_UPSTREAM_HOST || "redis",
  upstreamPort: parseInt(process.env.REDIS_UPSTREAM_PORT || "6379"),
});

startHttpProxy({
  port: parseInt(process.env.HTTP_PROXY_PORT || "8080"),
});

console.log("[proxy-entrypoint] All proxies started");
