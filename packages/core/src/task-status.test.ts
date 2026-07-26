import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveTaskStatus, type TaskStatusFacts } from "./index.js";

const idle: TaskStatusFacts = {
  hasStarted: false,
  reviewRequired: false,
  sessions: [],
  interactions: [],
};

describe("deriveTaskStatus", () => {
  it("keeps a new task in todo", () => {
    assert.equal(deriveTaskStatus(idle), "todo");
  });

  it("prioritizes pending user interaction over running sessions", () => {
    assert.equal(deriveTaskStatus({
      ...idle,
      hasStarted: true,
      sessions: [{ runtimeStatus: "running" }],
      interactions: [{ status: "pending" }],
    }), "needs_attention");
  });

  it("moves completed agent work to review", () => {
    assert.equal(deriveTaskStatus({ ...idle, hasStarted: true, reviewRequired: true }), "in_review");
  });

  it("moves a failed Agent session to needs attention", () => {
    assert.equal(deriveTaskStatus({
      hasStarted: true, reviewRequired: true,
      sessions: [{ runtimeStatus: "failed" }], interactions: [],
    }), "needs_attention");
  });

  it("moves a resumable interrupted session to needs attention", () => {
    assert.equal(deriveTaskStatus({
      hasStarted: true, reviewRequired: true,
      sessions: [{ runtimeStatus: "suspended" }], interactions: [],
    }), "needs_attention");
  });
});
