import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  esc, safeHref, timeAgo, statusColor, linkify,
  renderActivityEntry,
} from "../../packages/libclaudebox/html/shared.ts";

describe("esc", () => {
  it("escapes HTML entities", () => {
    assert.equal(esc('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it("escapes ampersands", () => {
    assert.equal(esc("a&b"), "a&amp;b");
  });

  it("escapes single quotes", () => {
    assert.equal(esc("it's"), "it&#39;s");
  });

  it("passes through safe text unchanged", () => {
    assert.equal(esc("hello world"), "hello world");
  });
});

describe("safeHref", () => {
  it("allows http URLs", () => {
    assert.equal(safeHref("http://example.com"), "http://example.com");
  });

  it("allows https URLs", () => {
    assert.equal(safeHref("https://example.com"), "https://example.com");
  });

  it("blocks javascript: URLs", () => {
    assert.equal(safeHref("javascript:alert(1)"), "#");
  });

  it("blocks data: URLs", () => {
    assert.equal(safeHref("data:text/html,<h1>hi</h1>"), "#");
  });

  it("escapes special chars in URL", () => {
    assert.equal(safeHref('https://example.com/"test"'), 'https://example.com/&quot;test&quot;');
  });
});

describe("statusColor", () => {
  it("returns green for running", () => {
    assert.equal(statusColor("running"), "#61D668");
  });

  it("returns red for error", () => {
    assert.equal(statusColor("error"), "#E94560");
  });

  it("returns grey for unknown status", () => {
    assert.equal(statusColor("whatever"), "#888");
  });
});

describe("linkify", () => {
  it("converts bare URLs to links", () => {
    const result = linkify("visit https://example.com/page today");
    assert.ok(result.includes('href="https://example.com/page"'));
    assert.ok(result.includes('target="_blank"'));
  });

  it("converts markdown links to HTML", () => {
    const result = linkify("[click here](https://example.com)");
    assert.ok(result.includes(">click here</a>"));
    assert.ok(result.includes('href="https://example.com"'));
  });

  it("escapes XSS in markdown link labels", () => {
    const result = linkify('[<img onerror=alert(1)>](https://example.com)');
    assert.ok(!result.includes("<img"));
    assert.ok(result.includes("&lt;img"));
  });

  it("handles text with no URLs", () => {
    assert.equal(linkify("just plain text"), "just plain text");
  });

  it("does not double-link markdown links", () => {
    const result = linkify("[PR #5](https://github.com/test/pull/5)");
    // Should have exactly one <a> tag
    const links = result.match(/<a /g);
    assert.equal(links?.length, 1);
  });
});

describe("compactArtifact (via renderActivityEntry)", () => {
  const ts = new Date().toISOString();

  it("compacts PR markdown links", () => {
    const html = renderActivityEntry({ ts, type: "artifact", text: "- [PR #5: fix overflow](https://github.com/test/pull/5)" });
    assert.ok(html.includes("PR #5"));
    assert.ok(html.includes('href="https://github.com/test/pull/5"'));
    assert.ok(html.includes("artifact-link"));
  });

  it("compacts issue references", () => {
    const html = renderActivityEntry({ ts, type: "artifact", text: "Issue #70: misleading comment — https://github.com/test/issues/70" });
    assert.ok(html.includes("#70"));
    assert.ok(html.includes('href="https://github.com/test/issues/70"'));
  });

  it("compacts closed issue references", () => {
    const html = renderActivityEntry({ ts, type: "artifact", text: "Closed issue #42: dup — https://github.com/test/issues/42" });
    assert.ok(html.includes("Closed #42"));
  });

  it("compacts gist references", () => {
    const html = renderActivityEntry({ ts, type: "artifact", text: "Gist: https://gist.github.com/user/abc123" });
    assert.ok(html.includes(">Gist</a>"));
    assert.ok(html.includes('href="https://gist.github.com/user/abc123"'));
  });

  it("compacts skill PR references", () => {
    const html = renderActivityEntry({ ts, type: "artifact", text: "Skill PR [/audit-module #3](https://github.com/test/pull/3)" });
    assert.ok(html.includes("PR #3"));
  });

  it("compacts audit label references", () => {
    const html = renderActivityEntry({ ts, type: "artifact", text: "Created audit label: scope/kzg-commitment" });
    assert.ok(html.includes("Label scope/kzg-commitment"));
  });

  it("falls back to linkify for unknown artifact format", () => {
    const html = renderActivityEntry({ ts, type: "artifact", text: "Some random artifact text https://example.com/page" });
    assert.ok(html.includes('href="https://example.com/page"'));
  });

  it("uses diamond icon for artifacts", () => {
    const html = renderActivityEntry({ ts, type: "artifact", text: "Gist: https://gist.github.com/x" });
    assert.ok(html.includes("\u25C6")); // ◆
  });
});

describe("renderActivityEntry types", () => {
  const ts = new Date().toISOString();

  it("renders response type with RE avatar", () => {
    const html = renderActivityEntry({ ts, type: "response", text: "hello" });
    assert.ok(html.includes("reply-avatar"));
    assert.ok(html.includes(">RE<"));
  });

  it("renders context type with CB avatar", () => {
    const html = renderActivityEntry({ ts, type: "context", text: "ctx" });
    assert.ok(html.includes(">CB<"));
  });

  it("renders tool_use with triangle icon", () => {
    const html = renderActivityEntry({ ts, type: "tool_use", text: "Read file=/path" });
    assert.ok(html.includes("\u25B8")); // ▸
    assert.ok(html.includes("Read"));
  });

  it("renders tool_use bash with $ prefix", () => {
    const html = renderActivityEntry({ ts, type: "tool_use", text: "$ git status" });
    assert.ok(html.includes("tool-bash"));
    assert.ok(html.includes("git status"));
  });

  it("renders tool_result with left triangle icon", () => {
    const html = renderActivityEntry({ ts, type: "tool_result", text: "Found 3 files" });
    assert.ok(html.includes("\u25C2")); // ◂
    assert.ok(html.includes("Found 3 files"));
  });

  it("renders status with circle icon", () => {
    const html = renderActivityEntry({ ts, type: "status", text: "working..." });
    assert.ok(html.includes("\u25CB")); // ○
  });

  it("renders agent_start with dot", () => {
    const html = renderActivityEntry({ ts, type: "agent_start", text: "exploring codebase" });
    assert.ok(html.includes("agent-dot"));
    assert.ok(html.includes("Agent:"));
  });

  it("renders agent_start with log URL when provided", () => {
    const html = renderActivityEntry({ ts, type: "agent_start", text: "exploring" }, "https://log.example.com");
    assert.ok(html.includes('href="https://log.example.com"'));
  });

  it("renders unknown type with dot icon", () => {
    const html = renderActivityEntry({ ts, type: "whatever", text: "hi" });
    assert.ok(html.includes("\u00B7")); // ·
  });
});
