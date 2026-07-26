import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conversationItems } from "./App.js";

describe("conversationItems", () => {
  it("merges streamed AG-UI text events into one rendered message", () => {
    const events = [
      { sequence: 1, type: "TEXT_MESSAGE_START", occurredAt: "2026-07-26T00:00:00.000Z", payload: { type: "TEXT_MESSAGE_START", messageId: "message-1", role: "assistant" } },
      { sequence: 2, type: "TEXT_MESSAGE_CONTENT", occurredAt: "2026-07-26T00:00:00.100Z", payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "message-1", delta: "Hello" } },
      { sequence: 3, type: "TEXT_MESSAGE_CONTENT", occurredAt: "2026-07-26T00:00:00.200Z", payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "message-1", delta: " world!" } },
      { sequence: 4, type: "TEXT_MESSAGE_END", occurredAt: "2026-07-26T00:00:00.300Z", payload: { type: "TEXT_MESSAGE_END", messageId: "message-1" } },
    ];

    const messages = conversationItems(events);

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.kind, "agent");
    assert.equal(messages[0]?.text, "Hello world!");
  });

  it("keeps AG-UI tool calls as separate conversation items", () => {
    const events = [
      { sequence: 1, type: "TEXT_MESSAGE_CONTENT", occurredAt: "2026-07-26T00:00:00.000Z", payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "message-1", delta: "Checking." } },
      { sequence: 2, type: "TOOL_CALL_START", occurredAt: "2026-07-26T00:00:01.000Z", payload: { type: "TOOL_CALL_START", toolCallId: "tool-1", toolCallName: "commandExecution" } },
      { sequence: 3, type: "TOOL_CALL_ARGS", occurredAt: "2026-07-26T00:00:01.100Z", payload: { type: "TOOL_CALL_ARGS", toolCallId: "tool-1", delta: "{\"command\":\"pnpm test\"}" } },
    ];

    const messages = conversationItems(events);

    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.kind, "tool");
    assert.equal(messages[1]?.title, "commandExecution");
  });

  it("keeps legacy events readable for existing task history", () => {
    const messages = conversationItems([
      { sequence: 1, type: "message.delta", occurredAt: "2026-07-26T00:00:00.000Z", payload: { itemId: "legacy-1", delta: "Legacy" } },
    ]);
    assert.equal(messages[0]?.text, "Legacy");
  });
});
