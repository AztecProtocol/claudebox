/**
 * Linear API client with audit logging.
 *
 * Clean wrapper — no grant checking. Security boundary is the token.
 */

import type { SessionContext } from "./types.ts";
import { audit } from "./audit.ts";

export interface LinearClientOpts {
  token: string;
  ctx: SessionContext;
}

export class LinearClient {
  private token: string;
  private ctx: SessionContext;

  constructor(opts: LinearClientOpts) {
    this.token = opts.token;
    this.ctx = opts.ctx;
  }

  get hasToken(): boolean { return !!this.token; }

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

    audit("linear", "read", `getIssue ${identifier}`, true);

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
      { filter: { number: { eq: parseInt(m[2], 10) }, team: { key: { eq: m[1].toUpperCase() } } } },
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
    audit("linear", "write", `createIssue team=${teamKey}`, true);

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
