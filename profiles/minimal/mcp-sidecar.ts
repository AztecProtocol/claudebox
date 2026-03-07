#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox Minimal Profile Sidecar
 *
 * A bare-bones profile that demonstrates extending ClaudeBox with
 * just the essential tools. No repo-specific configuration.
 *
 * Tools provided:
 *   - respond_to_user — post messages back to Slack/dashboard
 *   - session_status — update session status
 *   - github_api — generic GitHub API access
 *   - get_context — retrieve session context
 */

import {
  McpServer,
  registerCommonTools,
  startMcpHttpServer,
} from "../../packages/libclaudebox/mcp/base.ts";

function createServer(): McpServer {
  const server = new McpServer({ name: "claudebox-minimal", version: "1.0.0" });

  registerCommonTools(server, {
    tools: "respond_to_user, get_context, session_status, github_api",
  });

  return server;
}

startMcpHttpServer(createServer);
