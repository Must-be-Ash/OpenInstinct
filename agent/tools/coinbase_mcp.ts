import { defineDynamic, defineTool, type DynamicToolSet } from "eve/tools";
import {
  coinbaseApprovalResponderAllowed,
  coinbasePrincipalAllowed,
  requireCoinbaseAccess,
} from "../lib/coinbase-access";
import { coinbaseCredentialsConfigured } from "../lib/coinbase-cli";
import {
  callCoinbaseMcpTool,
  listCoinbaseMcpTools,
  type CoinbaseMcpToolDefinition,
} from "../lib/coinbase-mcp";
import {
  coinbaseToolAllowed,
  coinbaseToolRequiresApproval,
  enforceCoinbaseToolInput,
} from "../lib/coinbase-policy";

let cachedDefinitions: Promise<CoinbaseMcpToolDefinition[]> | undefined;

type EveJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly EveJsonValue[]
  | { readonly [key: string]: EveJsonValue };

type EveJsonObject = Readonly<Record<string, EveJsonValue>>;

function parseEveJsonValue(value: unknown): EveJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(parseEveJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).map((key) => {
        const entry: unknown = Reflect.get(value, key);
        return [key, parseEveJsonValue(entry)];
      })
    );
  }
  throw new Error("Coinbase returned a non-JSON tool schema.");
}

function isEveJsonObject(value: EveJsonValue): value is EveJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEveInputSchema(value: unknown): EveJsonObject {
  const parsed = parseEveJsonValue(value);
  if (!isEveJsonObject(parsed)) {
    throw new Error("Coinbase returned an invalid tool input schema.");
  }
  return parsed;
}

async function availableTools() {
  cachedDefinitions ??= listCoinbaseMcpTools().catch((error: unknown) => {
    cachedDefinitions = undefined;
    throw error;
  });
  return cachedDefinitions;
}

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx): Promise<DynamicToolSet | null> => {
      if (
        !coinbaseCredentialsConfigured() ||
        !coinbasePrincipalAllowed(ctx.session)
      ) {
        return null;
      }
      let definitions: CoinbaseMcpToolDefinition[];
      try {
        definitions = (await availableTools()).filter((definition) =>
          coinbaseToolAllowed(definition.name)
        );
      } catch {
        console.warn(
          "Coinbase tool discovery failed; Coinbase tools are unavailable for this session."
        );
        return null;
      }
      return Object.fromEntries(
        definitions.map(
          (definition): readonly [string, DynamicToolSet[string]] => {
            const requiresApproval = coinbaseToolRequiresApproval(
              definition.name
            );
            const description = `${definition.description ?? definition.name} ${requiresApproval ? "This changes Coinbase state or moves funds. The durable approval control authorizes this exact input; do not ask for another preliminary confirmation." : "This is a read-only Coinbase for Agents operation."}`;
            const inputSchema = parseEveInputSchema(definition.inputSchema);
            if (requiresApproval) {
              return [
                definition.name,
                defineTool({
                  description,
                  inputSchema,
                  approval: {
                    request(approvalContext) {
                      return coinbasePrincipalAllowed(approvalContext.session)
                        ? "user-approval"
                        : {
                            type: "denied",
                            reason: "This user is not authorized for Coinbase.",
                          };
                    },
                    response({ responder, session }) {
                      return coinbaseApprovalResponderAllowed(
                        responder,
                        session.initiator
                      )
                        ? { status: "allowed" }
                        : {
                            status: "rejected",
                            reason:
                              "Only the allowlisted user who requested this Coinbase action may approve it.",
                          };
                    },
                  },
                  async execute(input, toolCtx) {
                    requireCoinbaseAccess(toolCtx);
                    const toolInput = enforceCoinbaseToolInput(
                      definition.name,
                      input
                    );
                    const result = await callCoinbaseMcpTool(
                      definition.name,
                      toolInput,
                      toolCtx.abortSignal
                    );
                    return {
                      note: "This result is authoritative. Do not retry this mutation automatically if its outcome is ambiguous.",
                      result,
                    };
                  },
                }),
              ] as const;
            }
            return [
              definition.name,
              defineTool({
                description,
                inputSchema,
                async execute(input, toolCtx) {
                  requireCoinbaseAccess(toolCtx);
                  const toolInput = enforceCoinbaseToolInput(
                    definition.name,
                    input
                  );
                  const result = await callCoinbaseMcpTool(
                    definition.name,
                    toolInput,
                    toolCtx.abortSignal
                  );
                  return result;
                },
              }),
            ] as const;
          }
        )
      );
    },
  },
});
