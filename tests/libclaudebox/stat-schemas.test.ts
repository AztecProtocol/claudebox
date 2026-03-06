import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";


import { register, getSchema, allSchemas, schemasPrompt } from "../../packages/libclaudebox/stat-schemas.ts";

describe("stat-schemas", () => {
  it("registers built-in schemas on import", () => {
    const schemas = allSchemas();
    const names = schemas.map(s => s.name);
    assert.ok(names.includes("pr_analysis"), "should have pr_analysis");
    assert.ok(names.includes("audit_assessment"), "should have audit_assessment");
    assert.ok(names.includes("audit_file_review"), "should have audit_file_review");
    assert.ok(names.includes("audit_artifact"), "should have audit_artifact");
    assert.ok(names.includes("audit_summary"), "should have audit_summary");
  });

  it("getSchema returns correct schema by name", () => {
    const schema = getSchema("pr_analysis");
    assert.ok(schema);
    assert.equal(schema.name, "pr_analysis");
    assert.ok(schema.fields.length > 0);
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

  it("schemasPrompt formats all schemas as markdown", () => {
    const prompt = schemasPrompt();
    assert.ok(prompt.includes("### pr_analysis"));
    assert.ok(prompt.includes("### audit_file_review"));
    assert.ok(prompt.includes("quality_dimension"));
    // Check field formatting
    assert.ok(prompt.includes("  - pr (number):"));
  });

  describe("audit_file_review schema", () => {
    it("has quality_dimension field", () => {
      const schema = getSchema("audit_file_review")!;
      const dim = schema.fields.find(f => f.name === "quality_dimension");
      assert.ok(dim, "should have quality_dimension field");
      assert.ok(dim.description.includes("code"), "should mention code dimension");
      assert.ok(dim.description.includes("crypto"), "should mention crypto dimension");
      assert.ok(dim.description.includes("test"), "should mention test dimension");
    });

    it("has required audit fields", () => {
      const schema = getSchema("audit_file_review")!;
      const fieldNames = schema.fields.map(f => f.name);
      assert.ok(fieldNames.includes("file_path"));
      assert.ok(fieldNames.includes("module"));
      assert.ok(fieldNames.includes("review_depth"));
      assert.ok(fieldNames.includes("issues_found"));
    });
  });

  describe("audit_artifact schema", () => {
    it("has all required fields", () => {
      const schema = getSchema("audit_artifact")!;
      const fieldNames = schema.fields.map(f => f.name);
      assert.ok(fieldNames.includes("artifact_type"));
      assert.ok(fieldNames.includes("artifact_url"));
      assert.ok(fieldNames.includes("quality_dimension"));
      assert.ok(fieldNames.includes("severity"));
      assert.ok(fieldNames.includes("modules"));
      assert.ok(fieldNames.includes("title"));
    });
  });
});
