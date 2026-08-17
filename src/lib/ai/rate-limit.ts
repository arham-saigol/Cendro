import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";

export type AiRateLimitKind = "ai-chat" | "ai-title" | "ai-task-import";

export function consumeAiRateLimit(client: ConvexHttpClient, kind: AiRateLimitKind) {
  return client.mutation(api.aiChat.consumeRateLimit, { kind });
}
