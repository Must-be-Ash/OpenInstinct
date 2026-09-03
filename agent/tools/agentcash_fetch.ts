import { defineTool } from "eve/tools";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";
import {
  agentcashPaymentApprovalPolicy,
  requireAgentcashAccess,
} from "../lib/agentcash-access";
import { callAgentcashMcpTool } from "../lib/agentcash-mcp";
import { executeAgentcashPayment } from "../lib/agentcash-operation-store";
import {
  agentcashFetchSchema,
  enforceAgentcashFetch,
} from "../lib/agentcash-policy";
import { env } from "@/env";

export default defineTool({
  description:
    "Call one HTTPS API through Agentcash with automatic SIWX and x402/MPP payment. Invoke this tool directly after showing the caller-visible request and USD ceiling; Eve automatically pauses it for the user's one native approval. Never ask for approval with ask_question or prose. Call agentcash_check_endpoint_schema first for a new endpoint.",
  inputSchema: agentcashFetchSchema,
  approval: agentcashPaymentApprovalPolicy(),
  async execute(input, ctx) {
    requireAgentcashAccess(ctx);
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    if (caller?.principalType !== "user") {
      throw new Error("An authenticated user is required for Agentcash.");
    }
    const toolInput = enforceAgentcashFetch(
      input,
      env.AGENTCASH_MAX_PAYMENT_USD
    );
    return executeAgentcashPayment({
      callId: ctx.callId,
      operation: () =>
        callAgentcashMcpTool("fetch", toolInput, ctx.abortSignal),
      scope: scopeFromPrincipal(caller),
      toolInput,
    });
  },
});
