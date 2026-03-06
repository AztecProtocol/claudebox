// ── libclaudebox — Claude Code session orchestrator framework ──

// Profile system
export type { ProfileManifest, ProfileServer, DockerConfig, RouteRegistration, RouteHandler, RouteContext } from "./profile-types.ts";
export { setProfilesDir, discoverProfiles, loadProfile, getDockerConfig, buildChannelProfileMap, buildChannelBranchMap, collectProfileRoutes } from "./profile-loader.ts";

// Session management
export { SessionStore } from "./session-store.ts";
export type { SessionMeta, WorktreeInfo } from "./types.ts";

// Docker orchestration
export { DockerService } from "./docker.ts";

// Interactive terminal
export { InteractiveSessionManager } from "./interactive.ts";

// HTTP server
export { createHttpServer } from "./http-routes.ts";

// Stat schemas
export { getSchema, allSchemas, schemasPrompt } from "./stat-schemas.ts";
export type { StatSchema, StatField } from "./stat-schemas.ts";

// Server client (MCP sidecar ↔ server communication)
export { ServerClient, createServerClientFromEnv } from "./server-client.ts";
export type { ServerClientOpts, CommentSections } from "./server-client.ts";

// Utilities
export { QuestionStore } from "./question-store.ts";
