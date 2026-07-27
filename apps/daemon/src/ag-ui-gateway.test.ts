import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestUserText, threadMessages } from "./ag-ui-gateway.js";

describe("AG-UI Gateway", () => {
  it("uses the newest user message from a standard RunAgentInput", () => {
    assert.equal(latestUserText([
      { id: "a", role: "user", content: "Earlier request" },
      { id: "b", role: "assistant", content: "Earlier response" },
      { id: "c", role: "user", content: [{ type: "text", text: "Continue from here" }] },
    ]), "Continue from here");
  });

  it("projects persisted AG-UI text events into durable thread history", () => {
    const messages = threadMessages([
      { sequence: 1, id: "e1", type: "TEXT_MESSAGE_START", taskId: "task_1", sessionId: "session_1", provider: "codex", occurredAt: "2026-07-27T00:00:00.000Z", schemaVersion: 1, payload: { type: "TEXT_MESSAGE_START", messageId: "user_1", role: "user" } },
      { sequence: 2, id: "e2", type: "TEXT_MESSAGE_CONTENT", taskId: "task_1", sessionId: "session_1", provider: "codex", occurredAt: "2026-07-27T00:00:01.000Z", schemaVersion: 1, payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "user_1", delta: "Build it" } },
      { sequence: 3, id: "e3", type: "TEXT_MESSAGE_START", taskId: "task_1", sessionId: "session_1", provider: "codex", occurredAt: "2026-07-27T00:00:02.000Z", schemaVersion: 1, payload: { type: "TEXT_MESSAGE_START", messageId: "assistant_1", role: "assistant" } },
      { sequence: 4, id: "e4", type: "TEXT_MESSAGE_CONTENT", taskId: "task_1", sessionId: "session_1", provider: "codex", occurredAt: "2026-07-27T00:00:03.000Z", schemaVersion: 1, payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant_1", delta: "Done" } },
      { sequence: 5, id: "e5", type: "workspace.ready", taskId: "task_1", sessionId: null, provider: null, occurredAt: "2026-07-27T00:00:04.000Z", schemaVersion: 1, payload: {} },
    ]);
    assert.deepEqual(messages, [
      { id: "user_1", role: "user", content: "Build it" },
      { id: "assistant_1", role: "assistant", content: "Done" },
    ]);
  });
});
