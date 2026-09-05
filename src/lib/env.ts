import { z } from "zod";

const defaultAiModel = "accounts/fireworks/models/deepseek-v4-flash-0713";
const aiModelSchema = z.string().min(1).regex(/^accounts\/fireworks\/models\/[A-Za-z0-9._-]+$/, "AI_MODEL must use Fireworks format accounts/fireworks/models/<model>").default(defaultAiModel);
const aiChatServerSchema = z.object({
  NEXT_PUBLIC_CONVEX_URL: z.string().url(),
  FIREWORKS_API_KEY: z.string().min(1),
  AI_MODEL: aiModelSchema,
  AI_CHAT_PERSISTENCE_SECRET: z.string().min(16),
});

export function safeAiChatServerEnv() { return aiChatServerSchema.safeParse(process.env); }
