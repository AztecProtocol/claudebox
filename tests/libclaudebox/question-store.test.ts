import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";


import { QuestionStore, type QuestionInput } from "../../packages/libclaudebox/question-store.ts";

const TEST_DIR = join(tmpdir(), `claudebox-test-questions-${Date.now()}`);

function makeQuestion(overrides?: Partial<QuestionInput>): QuestionInput {
  return {
    description: "Test question",
    body: "Detailed body text",
    text: "What should we do?",
    context: "Reviewing module X",
    options: [
      { label: "Option A", description: "First option" },
      { label: "Option B", description: "Second option" },
    ],
    urgency: "important",
    ...overrides,
  };
}

describe("QuestionStore", () => {
  let store: QuestionStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new QuestionStore(TEST_DIR);
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  describe("addQuestions", () => {
    it("creates questions with generated IDs", () => {
      const questions = store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      assert.equal(questions.length, 1);
      assert.ok(questions[0].id);
      assert.equal(questions[0].worktree_id, "a1b2c3d4e5f60000");
      assert.equal(questions[0].status, "pending");
      assert.equal(questions[0].text, "What should we do?");
      assert.equal(questions[0].options.length, 2);
    });

    it("persists questions to JSONL file", () => {
      store.addQuestions("a1b2c3d4e5f60000", [makeQuestion(), makeQuestion({ text: "Q2" })]);
      const filePath = join(TEST_DIR, "a1b2c3d4e5f60000.jsonl");
      assert.ok(existsSync(filePath));
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      assert.equal(lines.length, 2);
    });

    it("appends to existing JSONL file", () => {
      store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      store.addQuestions("a1b2c3d4e5f60000", [makeQuestion({ text: "Follow-up?" })]);
      const questions = store.getQuestions("a1b2c3d4e5f60000");
      assert.equal(questions.length, 2);
    });

    it("sets deadline based on urgency", () => {
      const [critical] = store.addQuestions("a1b2c3d4e5f60000", [
        makeQuestion({ urgency: "critical" }),
      ]);
      const deadline = new Date(critical.deadline).getTime();
      const now = Date.now();
      // Critical = 30 min
      assert.ok(deadline > now);
      assert.ok(deadline <= now + 31 * 60_000);
    });
  });

  describe("getQuestions", () => {
    it("returns empty array for unknown worktree", () => {
      assert.deepEqual(store.getQuestions("b0000000000-none"), []);
    });

    it("returns all questions for a worktree", () => {
      store.addQuestions("a1b2c3d4e5f60000", [makeQuestion(), makeQuestion({ text: "Q2" })]);
      const questions = store.getQuestions("a1b2c3d4e5f60000");
      assert.equal(questions.length, 2);
    });

    it("filters by status", () => {
      const [q] = store.addQuestions("a1b2c3d4e5f60000", [
        makeQuestion(), makeQuestion({ text: "Q2" }),
      ]);
      store.answerQuestion("a1b2c3d4e5f60000", q.id, "Option A", undefined, "user");
      assert.equal(store.getQuestions("a1b2c3d4e5f60000", "pending").length, 1);
      assert.equal(store.getQuestions("a1b2c3d4e5f60000", "answered").length, 1);
    });
  });

  describe("answerQuestion", () => {
    it("marks question as answered and returns true", () => {
      const [q] = store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      const result = store.answerQuestion("a1b2c3d4e5f60000", q.id, "Option A", undefined, "testuser");
      assert.equal(result, true);

      const questions = store.getQuestions("a1b2c3d4e5f60000");
      const answered = questions.find(qq => qq.id === q.id);
      assert.ok(answered);
      assert.equal(answered!.status, "answered");
      assert.equal(answered!.selected_option, "Option A");
      assert.equal(answered!.answered_by, "testuser");
      assert.ok(answered!.answered_at);
    });

    it("returns false for non-existent question", () => {
      store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      const result = store.answerQuestion("a1b2c3d4e5f60000", "nonexistent", "Option A");
      assert.equal(result, false);
    });

    it("persists answer to file", () => {
      const [q] = store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      store.answerQuestion("a1b2c3d4e5f60000", q.id, "Option B", undefined, "testuser");
      // Re-read from disk
      const fresh = new QuestionStore(TEST_DIR);
      const questions = fresh.getQuestions("a1b2c3d4e5f60000");
      const answered = questions.find(qq => qq.id === q.id);
      assert.ok(answered);
      assert.equal(answered!.status, "answered");
      assert.equal(answered!.selected_option, "Option B");
    });

    it("returns false for already-answered question", () => {
      const [q] = store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      store.answerQuestion("a1b2c3d4e5f60000", q.id, "Option A");
      const result = store.answerQuestion("a1b2c3d4e5f60000", q.id, "Option B");
      assert.equal(result, false);
    });
  });

  describe("allResolved", () => {
    it("returns false for empty worktree", () => {
      assert.equal(store.allResolved("b0000000000-empty"), false);
    });

    it("returns false when pending questions exist", () => {
      store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      assert.equal(store.allResolved("a1b2c3d4e5f60000"), false);
    });

    it("returns true when all answered", () => {
      const [q] = store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      store.answerQuestion("a1b2c3d4e5f60000", q.id, "Option A");
      assert.equal(store.allResolved("a1b2c3d4e5f60000"), true);
    });
  });

  describe("expireOverdue", () => {
    it("expires questions past deadline", () => {
      const [q] = store.addQuestions("a1b2c3d4e5f60000", [
        makeQuestion({ urgency: "critical" }),
      ]);
      // Manually set deadline to past
      const questions = store.getQuestions("a1b2c3d4e5f60000");
      questions[0].deadline = new Date(Date.now() - 60_000).toISOString();
      const filePath = join(TEST_DIR, "a1b2c3d4e5f60000.jsonl");
      writeFileSync(filePath, questions.map(qq => JSON.stringify(qq)).join("\n") + "\n");

      const resolved = store.expireOverdue();
      const refreshed = store.getQuestions("a1b2c3d4e5f60000");
      const expired = refreshed.find(qq => qq.id === q.id);
      assert.equal(expired!.status, "expired");
      // All questions resolved → worktree ID in result
      assert.ok(resolved.includes("a1b2c3d4e5f60000"));
    });

    it("does not expire non-overdue questions", () => {
      store.addQuestions("a1b2c3d4e5f60000", [makeQuestion({ urgency: "nice-to-have" })]);
      const resolved = store.expireOverdue();
      assert.deepEqual(resolved, []);
      const questions = store.getQuestions("a1b2c3d4e5f60000");
      assert.equal(questions[0].status, "pending");
    });
  });

  describe("buildResumePrompt", () => {
    it("includes answered question selection", () => {
      const [q] = store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      store.answerQuestion("a1b2c3d4e5f60000", q.id, "Option A", undefined, "lead");
      const prompt = store.buildResumePrompt("a1b2c3d4e5f60000");
      assert.ok(prompt.includes("Option A"), "should include selected option");
      assert.ok(prompt.includes("lead"), "should include who answered");
    });

    it("includes direction if set", () => {
      store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      store.setDirection("a1b2c3d4e5f60000", "Focus on crypto correctness", "lead");
      const prompt = store.buildResumePrompt("a1b2c3d4e5f60000");
      assert.ok(prompt.includes("Focus on crypto correctness"));
    });

    it("includes expired question notice", () => {
      const [q] = store.addQuestions("a1b2c3d4e5f60000", [makeQuestion()]);
      const questions = store.getQuestions("a1b2c3d4e5f60000");
      questions[0].deadline = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(
        join(TEST_DIR, "a1b2c3d4e5f60000.jsonl"),
        questions.map(qq => JSON.stringify(qq)).join("\n") + "\n",
      );
      store.expireOverdue();
      const prompt = store.buildResumePrompt("a1b2c3d4e5f60000");
      assert.ok(prompt.includes("expired") || prompt.includes("No answer"));
    });
  });

  describe("setDirection / getDirection", () => {
    it("stores and retrieves direction", () => {
      store.setDirection("a1b2c3d4e5f60000", "Do X then Y", "admin");
      const dir = store.getDirection("a1b2c3d4e5f60000");
      assert.ok(dir);
      assert.equal(dir!.text, "Do X then Y");
      assert.equal(dir!.author, "admin");
    });

    it("returns null when no direction set", () => {
      assert.equal(store.getDirection("b0000000000-none"), null);
    });
  });
});
