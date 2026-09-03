import { connectLinqCredentials } from "@vercel/connect/eve";
import { LinqAPIV3 } from "@linqapp/sdk";
import type { AdapterPostableMessage } from "chat";
import type { JsonValue } from "eve/connections";
import {
  defaultLinqAuth,
  linqChannel,
  type LinqChannelConfig,
  type LinqChannelCredentials,
} from "eve/channels/linq";
import { z } from "zod";
import { getAuth } from "@/auth";
import { reactToMessageToolResultSchema } from "@/agent/lib/react-to-message";
import { sendMessageToolResultSchema } from "@/agent/lib/send-message";
import { normalizeAuthPhoneNumber } from "@/auth/phone-number";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";
import { accessScopeForUser, type AccessScope } from "@/lib/access-scope";
import { prepareLinqArtifactDelivery } from "../lib/linq-artifact-delivery";
import { prepareLinqImageArtifactDelivery } from "../lib/linq-image-artifact/delivery";
import {
  extractImageArtifactMarkdownReferences,
  stripImageArtifactMarkdownReferences,
} from "../lib/linq-image-artifact/markdown";
import { env } from "@/env";
import {
  finalizeScheduledReportDelivery,
  releaseScheduledReportDelivery,
  scheduledReportFromSession,
} from "@/agent/lib/schedules/report-lifecycle";

const verifiedPhoneUserSchema = z.object({
  id: z.string().min(1),
  phoneNumberVerified: z.literal(true),
});

const credentials = (
  env.LINQ_CONNECTOR
    ? connectLinqCredentials(env.LINQ_CONNECTOR)
    : {
        apiKey() {
          throw new Error(
            "LINQ_CONNECTOR is not configured for this deployment."
          );
        },
      }
) satisfies LinqChannelCredentials;

export default linqChannel({
  credentials,
  events: {
    async "action.result"(event, context, session) {
      const reaction = reactToMessageToolResultSchema.safeParse(event.result);
      if (event.status === "completed" && reaction.success) {
        if (!context.thread) {
          throw new Error(
            "react_to_message requires an active Linq conversation thread."
          );
        }
        const messageId = context.thread.toJSON().currentMessage?.id;
        if (!messageId) {
          throw new Error("react_to_message requires a current Linq message.");
        }
        const adapter = context.bot.getAdapter("linq");
        if (reaction.data.output.operation === "remove") {
          await adapter.removeReaction(
            context.thread.id,
            messageId,
            reaction.data.output.type
          );
        } else {
          await adapter.addReaction(
            context.thread.id,
            messageId,
            reaction.data.output.type
          );
        }
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const message = sendMessageToolResultSchema.safeParse(event.result);
      if (event.status === "completed" && message.success) {
        const { thread } = context;
        if (!thread) {
          throw new Error(
            "send_message requires an active Linq conversation thread."
          );
        }
        const report = scheduledReportFromSession(session);
        const idempotencyKey = report
          ? `scheduled-report:${report.runId}:${String(report.sequence)}`
          : undefined;
        const post = idempotencyKey
          ? (content: AdapterPostableMessage) =>
              context.bot
                .getAdapter("linq")
                .postMessage(thread.id, content, { idempotencyKey })
          : (content: AdapterPostableMessage) => thread.post(content);

        if (message.data.output.kind === "link") {
          const adapter = context.bot.getAdapter("linq");
          const { chatId, pendingHandle } = adapter.decodeThreadId(thread.id);
          if (pendingHandle || !chatId) {
            throw new Error(
              "A native link preview requires an existing Linq conversation."
            );
          }
          const apiKey = await credentials.apiKey();
          const client = new LinqAPIV3({ apiKey });
          await client.chats.messages.send(
            chatId,
            {
              message: {
                parts: [{ type: "link", value: message.data.output.url }],
              },
            },
            idempotencyKey ? { idempotencyKey } : undefined
          );
          await finalizeScheduledReportDelivery(session);
          return;
        }

        const attachments = message.data.output.attachments?.map(
          ({ kind, ...attachment }) => ({ ...attachment, type: kind })
        );
        const { text: requestedText } = message.data.output;
        if (!requestedText) {
          if (attachments?.length) {
            await post({ attachments, raw: "" });
          }
          await finalizeScheduledReportDelivery(session);
          return;
        }

        const caller =
          session.session.auth.current ?? session.session.auth.initiator;
        const outgoing = await prepareLinqTextDelivery(requestedText, {
          attachments,
          rootSessionId: report?.workerSessionId ?? session.session.id,
          scope: caller ? scopeFromPrincipal(caller) : undefined,
          sessionId: session.session.id,
        });
        await post(outgoing);
        await finalizeScheduledReportDelivery(session);
      }
    },
    async "message.completed"(event, context, session) {
      if (event.finishReason === "tool-calls") return;
      const report = scheduledReportFromSession(session);
      if (report) {
        await finalizeScheduledReportDelivery(session, "suppressed");
        return;
      }
      if (!event.message || !context.thread) return;
      if (event.finishReason === "error") return;
      const caller =
        session.session.auth.current ?? session.session.auth.initiator;
      const outgoing = await prepareLinqTextDelivery(event.message, {
        rootSessionId: session.session.id,
        scope: caller ? scopeFromPrincipal(caller) : undefined,
        sessionId: session.session.id,
      });
      await context.thread.post(outgoing);
    },
    async "input.requested"(event, context, session) {
      if (!context.thread || event.requests.length === 0) return;
      const approvals = event.requests.filter(
        (request) => request.kind === "tool-approval"
      );
      const approvalBatch =
        approvals.length > 1 && approvals.length === event.requests.length;
      const approvalMixedWithOtherInput =
        approvals.length > 0 && approvals.length < event.requests.length;
      const raw = [
        ...event.requests.map((request) => {
          const actionDetails =
            request.kind === "tool-approval"
              ? `\nTool: ${request.action.toolName}\nInput:\n${formatApprovalInput(request.action.input)}`
              : "";
          const labels = request.options?.map((option) => option.label) ?? [];
          if (
            labels.length > 0 &&
            !approvalBatch &&
            !approvalMixedWithOtherInput
          ) {
            return `${request.prompt}${actionDetails}\nReply with ${labels.join(" or ")}.`;
          }
          return request.allowFreeform
            ? `${request.prompt}${actionDetails}\nReply with your answer.`
            : `${request.prompt}${actionDetails}`;
        }),
        ...(approvalBatch
          ? [
              "These actions cannot be approved together by text. Reply with Cancel to reject all of them, then request one action at a time.",
            ]
          : []),
        ...(approvalMixedWithOtherInput
          ? [
              "This batch combines an approval with another question. Reply with Cancel to reject the protected action; I will then ask for the remaining input separately.",
            ]
          : []),
      ].join("\n\n");
      const requestIds = event.requests
        .map((request) => request.requestId)
        .toSorted()
        .join(",");
      await context.bot.getAdapter("linq").postMessage(
        context.thread.id,
        { raw },
        {
          idempotencyKey: `input-request:${session.session.id}:${requestIds}`,
        }
      );
    },
    async "session.completed"(_event, _context, session) {
      const report = scheduledReportFromSession(session);
      if (report) {
        await finalizeScheduledReportDelivery(session, "suppressed");
      }
    },
    async "turn.cancelled"(_event, _context, session) {
      await releaseScheduledReportDelivery(
        session,
        "Scheduled result reporting was cancelled."
      );
    },
    async "turn.failed"(event, context, session) {
      await releaseScheduledReportDelivery(session, event.message);
      if (scheduledReportFromSession(session) || !context.thread) return;
      await context.thread.post({
        raw: "I hit an error while handling your request. I couldn't confirm whether any requested action completed, so please check its status before retrying.",
      });
    },
  },
  async onMessage(context, message) {
    if (message.author.isBot) return null;

    const auth = defaultLinqAuth(message);
    const authorUserName = z.string().safeParse(message.author.userName);
    const phoneNumber = authorUserName.success
      ? normalizeAuthPhoneNumber(authorUserName.data)
      : undefined;
    const verifiedUserId = phoneNumber
      ? await findVerifiedAuthUserIdByPhoneNumber(phoneNumber)
      : undefined;
    const principalId = verifiedUserId
      ? `better-auth:${verifiedUserId}`
      : auth.principalId;
    const scope = accessScopeForUser(principalId);
    const attributes =
      verifiedUserId && phoneNumber
        ? {
            ...auth.attributes,
            conversationChannel: "linq",
            conversationId: context.thread.id,
            linqThreadId: context.thread.id,
            phoneNumber,
            workspaceId: scope.workspaceId,
          }
        : {
            ...auth.attributes,
            conversationChannel: "linq",
            conversationId: context.thread.id,
            linqThreadId: context.thread.id,
            workspaceId: scope.workspaceId,
          };
    return {
      auth: {
        ...auth,
        attributes,
        principalId,
      },
    };
  },
});

type LinqOutgoingMessage = Extract<AdapterPostableMessage, { raw: string }>;
type LinqOutgoingAttachment = NonNullable<
  LinqOutgoingMessage["attachments"]
>[number];

async function prepareLinqTextDelivery(
  requestedText: string,
  input: {
    readonly attachments?: LinqOutgoingAttachment[];
    readonly rootSessionId: string;
    readonly scope?: AccessScope;
    readonly sessionId: string;
  }
): Promise<LinqOutgoingMessage> {
  if (!input.scope) {
    const references = extractImageArtifactMarkdownReferences(requestedText);
    const text =
      references.length === 0
        ? requestedText
        : [
            stripImageArtifactMarkdownReferences(requestedText),
            "I couldn't attach the image.",
          ]
            .filter(Boolean)
            .join("\n\n");
    const outgoing: LinqOutgoingMessage = { raw: text };
    if (input.attachments?.length) outgoing.attachments = input.attachments;
    return outgoing;
  }

  const artifactDelivery = await prepareLinqArtifactDelivery(requestedText, {
    scope: input.scope,
  });
  const imageDelivery = await prepareLinqImageArtifactDelivery(
    artifactDelivery.markdown,
    {
      rootSessionId: input.rootSessionId,
      scope: input.scope,
    }
  );
  if (imageDelivery.failedArtifactIds.length > 0) {
    console.warn("[linq] browser image delivery failed", {
      artifactIds: imageDelivery.failedArtifactIds,
      sessionId: input.sessionId,
    });
  }
  if (artifactDelivery.failedArtifactIds.length > 0) {
    console.warn("[linq] artifact delivery failed", {
      artifactIds: artifactDelivery.failedArtifactIds,
      sessionId: input.sessionId,
    });
  }
  const failedImageCount = imageDelivery.failedArtifactIds.length;
  const imageFailureMessage =
    failedImageCount === 0
      ? ""
      : failedImageCount === 1
        ? "I couldn't attach one image."
        : `I couldn't attach ${String(failedImageCount)} images.`;
  const failedArtifactCount = artifactDelivery.failedArtifactIds.length;
  const artifactFailureMessage =
    failedArtifactCount === 0
      ? ""
      : failedArtifactCount === 1
        ? "I couldn't publish one artifact."
        : `I couldn't publish ${String(failedArtifactCount)} artifacts.`;
  const outgoing: LinqOutgoingMessage = {
    raw: [imageDelivery.text, imageFailureMessage, artifactFailureMessage]
      .filter(Boolean)
      .join("\n\n"),
  };
  const outgoingAttachments = [
    ...(input.attachments ?? []),
    ...artifactDelivery.attachments,
  ];
  if (outgoingAttachments.length > 0) {
    outgoing.attachments = outgoingAttachments;
  }
  if (imageDelivery.files.length > 0) outgoing.files = imageDelivery.files;
  return outgoing;
}

const sensitiveApprovalInputKey =
  /(?:api.?key|authorization|body|cookie|credential|mnemonic|password|preview.?token|private.?key|secret|signature|signed.?payload|token)$/iu;
const approvalInputMaximumCharacters = 2_800;

type LinqInputRequest = Parameters<
  NonNullable<NonNullable<LinqChannelConfig["events"]>["input.requested"]>
>[0]["requests"][number];
type ApprovalInput = LinqInputRequest["action"]["input"];

function formatApprovalInput(input: ApprovalInput) {
  const serialized = JSON.stringify(redactApprovalInput(input), null, 2);
  return serialized.length <= approvalInputMaximumCharacters
    ? serialized
    : `${serialized.slice(0, approvalInputMaximumCharacters)}\n… [input truncated]`;
}

function redactApprovalInput(input: ApprovalInput): ApprovalInput {
  const redacted: Record<string, JsonValue> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value === undefined) continue;
    redacted[key] = sensitiveApprovalInputKey.test(key)
      ? "[redacted]"
      : redactApprovalInputValue(value);
  }
  return redacted;
}

function redactApprovalInputValue(value: JsonValue): JsonValue {
  if (isJsonArray(value)) return value.map(redactApprovalInputValue);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JsonValue is already validated; this branch distinguishes its primitive and object variants.
  if (value === null || typeof value !== "object") return value;
  return redactApprovalInput(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

async function findVerifiedAuthUserIdByPhoneNumber(phoneNumber: string) {
  const auth = await getAuth();
  const context = await auth.$context;
  const user = await context.adapter.findOne({
    model: "user",
    where: [{ field: "phoneNumber", value: phoneNumber }],
  });
  const parsed = verifiedPhoneUserSchema.safeParse(user);
  return parsed.success ? parsed.data.id : undefined;
}
