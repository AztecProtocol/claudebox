/**
 * Aztec-specific configuration overrides.
 * Called from server.ts before anything else to set up paths, channel maps, etc.
 */
import { join } from "path";
import { homedir } from "os";

// Override env defaults for Aztec deployment
if (!process.env.CLAUDE_REPO_DIR) process.env.CLAUDE_REPO_DIR = join(homedir(), "aztec-packages");
if (!process.env.CLAUDEBOX_HOST) process.env.CLAUDEBOX_HOST = "claudebox.work";
if (!process.env.CLAUDEBOX_SESSION_USER) process.env.CLAUDEBOX_SESSION_USER = "aztec";
if (!process.env.CLAUDEBOX_DEFAULT_BRANCH) process.env.CLAUDEBOX_DEFAULT_BRANCH = "next";
if (!process.env.SLACK_WORKSPACE_DOMAIN) process.env.SLACK_WORKSPACE_DOMAIN = "aztecprotocol";
if (!process.env.CLAUDEBOX_CONTAINER_USER) process.env.CLAUDEBOX_CONTAINER_USER = "aztec-dev";
if (!process.env.CLAUDEBOX_DOCKER_IMAGE) process.env.CLAUDEBOX_DOCKER_IMAGE = "devbox:latest";
