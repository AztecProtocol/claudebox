/**
 * Linear credential client.
 *
 * Every Linear API call goes through this module.
 * Read-only by default; write operations require canWrite + team in allowedTeams.
 */

import type { SessionContext, ProfileGrant } from "./types.ts";
import { audit, deny } from "./audit.ts";

export interface LinearClientOpts {
  token: string;
  ctx: SessionContext;
  grant: ProfileGrant["linear"];
}

export class LinearClient {
  private token: string;
  private ctx: SessionContext;
  private grant: ProfileGrant["linear"];

  constructor(opts: LinearClientOpts) {
    this.token = opts.token;
    this.ctx = opts.ctx;
    this.grant = opts.grant;
  }

  get hasToken(): boolean { return !!this.token; }

  // ── Grant checks ────────────────────────────────────────────────

  private requireRead(detail: string): void {
    if (!this.grant) deny("linear", "read", detail, `no Linear grant for profile '${this.ctx.profile}'`);
    audit("linear", "read", detail, true);
  }

  private requireWrite(team: string, detail: string): void {
    if (!this.grant) deny("linear", "write", detail, `no Linear grant for profile '${this.ctx.profile}'`);
    if (!this.grant.canWrite) deny("linear", "write", detail, `writes not allowed for profile '${this.ctx.profile}'`);
    if (this.grant.allowedTeams && !this.grant.allowedTeams.includes(team.toUpperCase())) {
      deny("linear", "write", detail, `team '${team}' not in allowed teams for profile '${this.ctx.profile}'`);
    }
    audit("linear", "write", detail, true);
  }

  // ── Transport ───────────────────────────────────────────────────

  private async graphql(query: string, variables?: Record<string, any>): Promise<any> {
    if (!this.token) throw new Error("[libcreds] No Linear token available");

    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: this.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Linear API ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = await res.json() as any;
    if (json.errors?.length) {
      throw new Error(`Linear GraphQL: ${json.errors.map((e: any) => e.message).join(", ")}`);
    }
    return json.data;
  }

  // ── READ ────────────────────────────────────────────────────────

  async getIssue(identifier: string): Promise<any> {
    const m = identifier.match(/^([A-Za-z][\w-]*)-(\d+)$/);
    if (!m) throw new Error(`Invalid Linear identifier: ${identifier}`);

    const teamKey = m[1].toUpperCase();
    const number = parseInt(m[2], 10);

    this.requireRead(`getIssue ${identifier}`);

    const data = await this.graphql(
      `query($filter: IssueFilter) {
        issues(filter: $filter, first: 1) {
          nodes {
            identifier title description url
            state { name }
            assignee { name }
            labels { nodes { name } }
            priority priorityLabel
            comments { nodes { body user { name } createdAt } }
          }
        }
      }`,
      { filter: { number: { eq: number }, team: { key: { eq: teamKey } } } },
    );

    const issue = data?.issues?.nodes?.[0];
    if (!issue) throw new Error(`Issue ${identifier} not found`);
    return issue;
  }

  // ── WRITE ───────────────────────────────────────────────────────

  async createIssue(opts: {
    team: string;
    title: string;
    description?: string;
    priority?: number;
  }): Promise<{ identifier: string; title: string; url: string }> {
    const teamKey = opts.team.toUpperCase();
    this.requireWrite(teamKey, `createIssue team=${teamKey}`);

    const teamData = await this.graphql(
      `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
      { key: teamKey },
    );
    const teamId = teamData?.teams?.nodes?.[0]?.id;
    if (!teamId) throw new Error(`Linear team '${opts.team}' not found`);

    const input: any = { teamId, title: opts.title };
    if (opts.description) input.description = opts.description;
    if (opts.priority !== undefined) input.priority = opts.priority;

    const data = await this.graphql(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { identifier title url }
        }
      }`,
      { input },
    );

    const result = data?.issueCreate;
    if (!result?.success) throw new Error(`Failed to create Linear issue`);
    return { identifier: result.issue.identifier, title: result.issue.title, url: result.issue.url };
  }
}
