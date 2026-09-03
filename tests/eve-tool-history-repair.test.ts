import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { repairToolCallHistory } from "../node_modules/eve/dist/src/harness/messages.js";
import { isRetryableModelResponse } from "../node_modules/eve/dist/src/harness/tool-loop.js";

const call = (toolCallId: string) => ({
  input: {},
  toolCallId,
  toolName: "read_status",
  type: "tool-call" as const,
});

const result = (toolCallId: string) => ({
  output: { type: "text" as const, value: "ok" },
  toolCallId,
  toolName: "read_status",
  type: "tool-result" as const,
});

describe("Eve model history repair", () => {
  it("retries an error-finished response that executed no tools", () => {
    expect(
      isRetryableModelResponse({
        finishReason: "error",
        response: { messages: [] },
        text: "Approved. Fetching the report now.",
        toolCalls: [],
        toolResults: [],
      })
    ).toBe(true);
  });

  it("preserves a complete tool-call batch", () => {
    const messages: ModelMessage[] = [
      { content: [call("call-a")], role: "assistant" },
      { content: [result("call-a")], role: "tool" },
    ];

    expect(repairToolCallHistory(messages)).toEqual(messages);
  });

  it("removes a mismatched batch while preserving assistant text", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          { text: "Checking now.", type: "text" },
          call("call-a"),
          call("call-b"),
        ],
        role: "assistant",
      },
      { content: [result("call-a")], role: "tool" },
      { content: "Try again", role: "user" },
    ];

    expect(repairToolCallHistory(messages)).toEqual([
      {
        content: [{ text: "Checking now.", type: "text" }],
        role: "assistant",
      },
      { content: "Try again", role: "user" },
    ]);
  });

  it("drops orphaned tool results", () => {
    const messages: ModelMessage[] = [
      { content: [result("orphan")], role: "tool" },
      { content: "Hello", role: "user" },
    ];

    expect(repairToolCallHistory(messages)).toEqual([
      { content: "Hello", role: "user" },
    ]);
  });
});
