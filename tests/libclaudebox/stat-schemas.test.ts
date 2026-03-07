import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { register, getSchema, allSchemas, schemasPrompt } from "../../packages/libclaudebox/stat-schemas.ts";

describe("stat-schemas", () => {
  it("starts empty (schemas registered by plugins)", () => {
    // Framework starts clean; plugins register on setup()
    assert.ok(Array.isArray(allSchemas()));
  });

  it("getSchema returns undefined for unknown name", () => {
    assert.equal(getSchema("nonexistent"), undefined);
  });

  it("register adds a new schema", () => {
    register({
      name: "test_schema_12345",
      description: "Test schema",
      fields: [{ name: "foo", type: "string", description: "A field" }],
    });
    const s = getSchema("test_schema_12345");
    assert.ok(s);
    assert.equal(s.fields.length, 1);
    assert.equal(s.fields[0].name, "foo");
  });

  it("register overwrites existing schema", () => {
    register({
      name: "test_overwrite",
      description: "v1",
      fields: [],
    });
    register({
      name: "test_overwrite",
      description: "v2",
      fields: [{ name: "bar", type: "number", description: "B" }],
    });
    const s = getSchema("test_overwrite");
    assert.ok(s);
    assert.equal(s.description, "v2");
    assert.equal(s.fields.length, 1);
  });

  it("schemasPrompt formats registered schemas as markdown", () => {
    register({
      name: "test_prompt_fmt",
      description: "A test schema for prompt formatting",
      fields: [
        { name: "count", type: "number", description: "A count field" },
        { name: "label", type: "string", description: "A label" },
      ],
    });
    const prompt = schemasPrompt();
    assert.ok(prompt.includes("### test_prompt_fmt"));
    assert.ok(prompt.includes("  - count (number):"));
    assert.ok(prompt.includes("  - label (string):"));
  });
});
