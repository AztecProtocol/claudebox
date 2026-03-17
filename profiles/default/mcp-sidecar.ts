#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox Default Profile Sidecar
 *
 * Repo: AztecProtocol/aztec-packages (public)
 * Clone strategy: local reference repo (/reference-repo/.git)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAztecPackagesTools } from "../shared/aztec-packages-sidecar.ts";
import { startMcpHttpServer } from "../../packages/libclaudebox/mcp/server.ts";

function createServer(): McpServer {
  const server = new McpServer({ name: "claudebox-default", version: "1.0.0" });

  registerAztecPackagesTools(server, {
    extraIssueRepos: [
      { name: "barretenberg_create_issue", repo: "AztecProtocol/barretenberg", description: "Create a GitHub issue in AztecProtocol/barretenberg." },
    ],
  });

  return server;
}

startMcpHttpServer(createServer);
