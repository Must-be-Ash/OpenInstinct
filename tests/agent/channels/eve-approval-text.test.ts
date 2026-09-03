import { describe, expect, it, vi } from "vitest";
import { resolveTextToResponse } from "eve/client";
import { z } from "zod";
import { coordinateApprovalDelivery } from "../../../node_modules/eve/dist/src/harness/approval-delivery-coordinator.js";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../../../node_modules/eve/dist/src/context/keys.js";
import type {
  HarnessSession,
  HarnessToolMap,
} from "../../../node_modules/eve/dist/src/harness/types.js";

const approvalRequest = {
  action: {
    callId: "coinbase-create-call",
    input: {},
    kind: "tool-call" as const,
    toolName: "coinbase_create_order",
  },
  allowFreeform: false,
  display: "confirmation" as const,
  kind: "tool-approval" as const,
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve tool call: coinbase_create_order",
  requestId: "approval-1",
};

describe("Eve text approval fallback", () => {
  it("resolves explicit approval labels", () => {
    expect(resolveTextToResponse("Approve", approvalRequest)).toEqual({
      optionId: "approve",
      requestId: "approval-1",
    });
    expect(resolveTextToResponse("Cancel", approvalRequest)).toEqual({
      optionId: "cancel",
      requestId: "approval-1",
    });
  });

  it("binds one authenticated text reply to one protected approval", async () => {
    const responder = {
      attributes: {},
      authenticator: "linq-message",
      issuer: "linq",
      principalId: "test-user",
      principalType: "user" as const,
      subject: "linq-user-1",
    };
    const session: HarnessSession = {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "continuation-1",
      history: [],
      sessionId: "session-1",
      state: {
        "eve.runtime.pendingInputBatches": [
          {
            event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
            requests: [approvalRequest],
            responseAuthRequiredRequestIds: [approvalRequest.requestId],
            responseMessages: [],
          },
        ],
      },
    };

    const result = await coordinateApprovalDelivery({
      session,
      stepInput: { message: "yes", messageAuth: responder },
      tools: new Map(),
    });

    expect(result.kind).toBe("continue-coordination");
    expect(result.feedback).toEqual([]);
    expect(result.stepInput?.message).toBeUndefined();

    const responsePolicy = vi.fn<() => Promise<{ status: "allowed" }>>(
      async () => ({ status: "allowed" })
    );
    const tools: HarnessToolMap = new Map([
      [
        "coinbase_create_order",
        {
          approval: {
            request: () => "user-approval" as const,
            response: responsePolicy,
          },
          description: "Execute one Coinbase order.",
          inputSchema: z.object({}),
          name: "coinbase_create_order",
        },
      ],
    ]);
    const runtimeContext = new ContextContainer();
    runtimeContext.set(SessionKey, {
      auth: { current: responder, initiator: responder },
      sessionId: session.sessionId,
      turn: { id: "turn-1", sequence: 1 },
    });
    const authorized = await contextStorage.run(runtimeContext, () =>
      coordinateApprovalDelivery({ session: result.session, tools })
    );

    expect(authorized.kind).toBe("continue");
    expect(authorized.stepInput?.inputResponses).toEqual([
      { optionId: "approve", requestId: approvalRequest.requestId },
    ]);
    expect(responsePolicy).toHaveBeenCalledOnce();

    await contextStorage.run(runtimeContext, () =>
      coordinateApprovalDelivery({
        session: authorized.session,
        stepInput: { message: "yes", messageAuth: responder },
        tools,
      })
    );
    expect(responsePolicy).toHaveBeenCalledOnce();
  });

  it("does not bind an unattributed text reply to a protected approval", async () => {
    const session: HarnessSession = {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "continuation-1",
      history: [],
      sessionId: "session-1",
      state: {
        "eve.runtime.pendingInputBatches": [
          {
            event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
            requests: [approvalRequest],
            responseAuthRequiredRequestIds: [approvalRequest.requestId],
            responseMessages: [],
          },
        ],
      },
    };

    const result = await coordinateApprovalDelivery({
      session,
      stepInput: { message: "yes" },
      tools: new Map(),
    });

    expect(result.kind).toBe("continue");
    expect(result.stepInput?.message).toBe("yes");
    expect(result.stepInput?.inputResponses).toEqual([]);
  });

  it("does not let one text reply approve a batch of protected actions", async () => {
    const secondApprovalRequest = {
      ...approvalRequest,
      action: {
        ...approvalRequest.action,
        callId: "coinbase-create-call-2",
      },
      requestId: "approval-2",
    };
    const session: HarnessSession = {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "continuation-1",
      history: [],
      sessionId: "session-1",
      state: {
        "eve.runtime.pendingInputBatches": [
          {
            event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
            requests: [approvalRequest, secondApprovalRequest],
            responseAuthRequiredRequestIds: [
              approvalRequest.requestId,
              secondApprovalRequest.requestId,
            ],
            responseMessages: [],
          },
        ],
      },
    };

    const result = await coordinateApprovalDelivery({
      session,
      stepInput: { message: "yes" },
      tools: new Map(),
    });

    expect(result.kind).toBe("continue");
    expect(result.stepInput?.message).toBe("yes");
  });

  it("lets one authenticated Cancel reply reject a protected action batch", async () => {
    const secondApprovalRequest = {
      ...approvalRequest,
      action: {
        ...approvalRequest.action,
        callId: "coinbase-create-call-2",
      },
      requestId: "approval-2",
    };
    const responder = {
      attributes: {},
      authenticator: "linq-message",
      issuer: "linq",
      principalId: "test-user",
      principalType: "user" as const,
      subject: "linq-user-1",
    };
    const session: HarnessSession = {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "continuation-1",
      history: [],
      sessionId: "session-1",
      state: {
        "eve.runtime.pendingInputBatches": [
          {
            event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
            requests: [approvalRequest, secondApprovalRequest],
            responseAuthRequiredRequestIds: [
              approvalRequest.requestId,
              secondApprovalRequest.requestId,
            ],
            responseMessages: [],
          },
        ],
      },
    };

    const result = await coordinateApprovalDelivery({
      session,
      stepInput: { message: "Cancel", messageAuth: responder },
      tools: new Map(),
    });

    expect(result.kind).toBe("continue-coordination");
    expect(result.stepInput?.message).toBeUndefined();
    const runtimeContext = new ContextContainer();
    runtimeContext.set(SessionKey, {
      auth: { current: responder, initiator: responder },
      sessionId: session.sessionId,
      turn: { id: "turn-1", sequence: 1 },
    });
    const settled = await contextStorage.run(runtimeContext, () =>
      coordinateApprovalDelivery({ session: result.session, tools: new Map() })
    );

    expect(settled.kind).toBe("continue");
    expect(settled.stepInput?.inputResponses).toEqual([
      { optionId: "cancel", requestId: "approval-1" },
      { optionId: "cancel", requestId: "approval-2" },
    ]);
  });

  it("lets authenticated Cancel reject the protected part of a mixed batch", async () => {
    const responder = {
      attributes: {},
      authenticator: "linq-message",
      issuer: "linq",
      principalId: "test-user",
      principalType: "user" as const,
      subject: "linq-user-1",
    };
    const questionRequest = {
      action: {
        callId: "question-call",
        input: {},
        kind: "tool-call" as const,
        toolName: "ask_question",
      },
      allowFreeform: true,
      display: "text" as const,
      kind: "question" as const,
      prompt: "Which account?",
      requestId: "question-1",
    };
    const session: HarnessSession = {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "continuation-1",
      history: [],
      sessionId: "session-1",
      state: {
        "eve.runtime.pendingInputBatches": [
          {
            event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
            requests: [approvalRequest, questionRequest],
            responseAuthRequiredRequestIds: [approvalRequest.requestId],
            responseMessages: [],
          },
        ],
      },
    };

    const result = await coordinateApprovalDelivery({
      session,
      stepInput: { message: "Cancel", messageAuth: responder },
      tools: new Map(),
    });

    expect(result.kind).toBe("continue-coordination");
    expect(result.stepInput?.message).toBeUndefined();
  });
});
