/**
 * MCP tools for cron job management.
 *
 * Permissions:
 * - list_crons: all sessions
 * - create_cron / update_cron: only --cron-allow sessions
 * - delete_cron: all sessions (cron-originated can only delete own)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CRON_ALLOW, CRON_JOB_ID, SESSION_META } from "./env.ts";
import { getHostClient } from "./activity.ts";

export function registerCronTools(server: McpServer): void {
  const client = getHostClient();
  const slackChannel = process.env.CLAUDEBOX_SLACK_CHANNEL || "";

  server.tool("list_crons",
    "List scheduled cron jobs. Optionally filter by channel ID.",
    {
      channel_id: z.string().optional().describe("Slack channel ID to filter by (defaults to current session's channel)"),
    },
    async ({ channel_id }) => {
      try {
        const jobs = await client.listCrons(channel_id || slackChannel || undefined);
        if (!jobs.length) {
          return { content: [{ type: "text", text: "No cron jobs found." }] };
        }
        const lines = jobs.map((j: any) =>
          `- **${j.name}** (${j.id}): \`${j.schedule}\` ${j.enabled ? "✓" : "⏸"} — ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? "..." : ""}`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to list crons: ${e.message}` }], isError: true };
      }
    });

  server.tool("create_cron",
    "Create a new scheduled cron job. Requires --cron-allow flag on the session.",
    {
      name: z.string().describe("Human-readable name for the cron job"),
      schedule: z.string().describe("Cron expression (5-field): '*/30 * * * *' = every 30 min, '0 9 * * *' = daily 9am"),
      prompt: z.string().describe("Prompt to run each time the cron fires"),
      channel_id: z.string().optional().describe("Target Slack channel (defaults to current session's channel)"),
    },
    async ({ name, schedule, prompt, channel_id }) => {
      if (!CRON_ALLOW) {
        return { content: [{ type: "text", text: "Permission denied: session does not have --cron-allow flag." }], isError: true };
      }
      try {
        const job = await client.createCron({
          channel_id: channel_id || slackChannel,
          name,
          schedule,
          prompt,
          user: SESSION_META.user || "agent",
        });
        return { content: [{ type: "text", text: `Created cron "${job.name}" (${job.id}) — schedule: ${job.schedule}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to create cron: ${e.message}` }], isError: true };
      }
    });

  server.tool("update_cron",
    "Update a cron job's schedule, prompt, name, or enabled state. Requires --cron-allow flag.",
    {
      id: z.string().describe("Cron job ID"),
      name: z.string().optional().describe("New name"),
      schedule: z.string().optional().describe("New cron expression"),
      prompt: z.string().optional().describe("New prompt"),
      enabled: z.boolean().optional().describe("Enable or disable"),
    },
    async ({ id, name, schedule, prompt, enabled }) => {
      if (!CRON_ALLOW) {
        return { content: [{ type: "text", text: "Permission denied: session does not have --cron-allow flag." }], isError: true };
      }
      try {
        const patch: Record<string, any> = {};
        if (name !== undefined) patch.name = name;
        if (schedule !== undefined) patch.schedule = schedule;
        if (prompt !== undefined) patch.prompt = prompt;
        if (enabled !== undefined) patch.enabled = enabled;
        const job = await client.updateCron(id, patch);
        return { content: [{ type: "text", text: `Updated cron "${job.name}" (${job.id})` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to update cron: ${e.message}` }], isError: true };
      }
    });

  server.tool("delete_cron",
    "Delete a cron job. Cron-originated sessions can only delete the cron that spawned them.",
    {
      id: z.string().describe("Cron job ID to delete"),
    },
    async ({ id }) => {
      // Cron-originated sessions can only delete their own cron
      if (CRON_JOB_ID && id !== CRON_JOB_ID) {
        return { content: [{ type: "text", text: `Permission denied: cron-originated sessions can only delete their own cron (${CRON_JOB_ID}).` }], isError: true };
      }
      try {
        await client.deleteCron(id);
        return { content: [{ type: "text", text: `Deleted cron ${id}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to delete cron: ${e.message}` }], isError: true };
      }
    });
}
