import { z } from "zod";

const aiChatServerSchema = z.object({
  NEXT_PUBLIC_CONVEX_URL: z.string().url(),
  FIREWORKS_API_KEY: z.string().min(1),
  AI_CHAT_PERSISTENCE_SECRET: z.string().min(16),
});

export function safeAiChatServerEnv() { return aiChatServerSchema.safeParse(process.env); }
