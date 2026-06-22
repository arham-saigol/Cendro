import { createFireworks } from "@ai-sdk/fireworks";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { auth } from "@clerk/nextjs/server";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import type { Id, TableNames } from "../../../../../convex/_generated/dataModel";
import { buildCendroAiTools, createCendroAiContext } from "@/lib/ai/registry";
import { consumeAiRateLimit } from "@/lib/ai/rate-limit";
import { CENDRO_AI_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { safeAiChatServerEnv } from "@/lib/env";
import { finalTextOfAssistantMessage, serializeAssistantMessage, textOf, toModelMessage } from "@/lib/message-utils";

const idSchema = <Table extends TableNames>() => z.custom<Id<Table>>((value) => typeof value === "string");
const modelTierSchema = z.union([z.literal("flash"), z.literal("pro")]);
const requestSchema = z.object({ messages: z.array(z.any()).max(100), companyId: idSchema<"companies">(), sessionId: idSchema<"aiChatSessions">(), modelTier: modelTierSchema.default("pro") });

type ModelTier = z.infer<typeof modelTierSchema>;

type ChatRouting =
  | { modelTier: "flash"; provider: "stepfun" }
  | { modelTier: "pro"; provider: "deepseek" | "kimi" };

function filePartsOf(message: any) {
  return (Array.isArray(message?.parts) ? message.parts : []).filter((part: any) => part?.type === "file");
}

function hasFileAttachment(message: any) {
  return filePartsOf(message).length > 0;
}

function storageContentOf(message: any) {
  const text = textOf(message).trim();
  const files = filePartsOf(message)
    .map((part: any) => typeof part.filename === "string" && part.filename.trim() ? part.filename.trim() : "attachment")
    .slice(0, 6);
  if (!files.length) return text;
  const attachmentText = files.length === 1 ? `[Attached file: ${files[0]}]` : `[Attached files: ${files.join(", ")}]`;
  return text ? `${text}\n\n${attachmentText}` : attachmentText;
}

function routeFor(modelTier: ModelTier, hasAttachment: boolean): ChatRouting {
  if (modelTier === "flash") return { modelTier, provider: "stepfun" };
  return { modelTier, provider: hasAttachment ? "kimi" : "deepseek" };
}

function modelFor(route: ChatRouting, env: { FIREWORKS_API_KEY: string; STEPFUN_API_KEY: string; DEEPSEEK_API_KEY: string; AI_MODEL: string }) {
  if (route.provider === "stepfun") return createOpenAICompatible({ name: "stepfun", baseURL: "https://api.stepfun.ai/v1", apiKey: env.STEPFUN_API_KEY })("step-3.7-flash");
  if (route.provider === "deepseek") return createOpenAICompatible({ name: "deepseek", baseURL: "https://api.deepseek.com", apiKey: env.DEEPSEEK_API_KEY })("deepseek-v4-pro");
  return createFireworks({ apiKey: env.FIREWORKS_API_KEY })(env.AI_MODEL as any);
}

function providerOptionsFor(route: ChatRouting): any {
  if (route.provider === "kimi") return { fireworks: { reasoningEffort: "medium" } };
  if (route.provider === "stepfun") return { stepfun: { reasoningEffort: "medium" } };
  return undefined;
}

const MAX_AGENT_STEPS = 16;
const FINAL_ANSWER_STEP = MAX_AGENT_STEPS - 1;

export async function POST(req: Request) {
  try {
    const env = safeAiChatServerEnv();
    if (!env.success) return Response.json({ error: "AI chat is not configured" }, { status: 503 });

    const body = await req.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Invalid request body" }, { status: 400 });

    const { messages, companyId, sessionId } = parsed.data;
    const { getToken } = await auth();
    const token = await getToken({ template: "convex" });
    if (!token) return Response.json({ error: "Missing Convex auth token" }, { status: 401 });

    const client = new ConvexHttpClient(env.data.NEXT_PUBLIC_CONVEX_URL);
    client.setAuth(token);
    const rateLimit = await consumeAiRateLimit(client, "ai-chat");
    if (!rateLimit.ok) return Response.json({ error: "Too many AI chat requests" }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } });

    let agentContext;
    try {
      agentContext = await createCendroAiContext({ client, companyId, sessionId });
    } catch {
      return Response.json({ error: "Chat session not found" }, { status: 404 });
    }

    const session = await client.query(api.aiChat.getSession, { companyId, sessionId });
    let persisted = await client.query(api.aiChat.listMessages, { companyId, sessionId });
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const latestHasAttachment = latestUser ? hasFileAttachment(latestUser) : false;
    const previousUserCount = persisted.filter((message) => message.role === "user").length;
    const routing: ChatRouting = session.modelTier === "flash"
      ? { modelTier: "flash", provider: "stepfun" }
      : session.modelTier === "pro" && session.proProvider
        ? { modelTier: "pro", provider: session.proProvider }
        : routeFor(parsed.data.modelTier, latestHasAttachment);

    if (routing.provider === "deepseek" && latestHasAttachment) {
      return Response.json({ error: "Create a new Pro session with attachments, or switch to Flash to add attachments anytime." }, { status: 400 });
    }

    if (!session.modelTier && latestUser && previousUserCount === 0) {
      await client.mutation(api.aiChat.setSessionModel, { companyId, sessionId, modelTier: routing.modelTier, ...(routing.modelTier === "pro" ? { proProvider: routing.provider } : {}) });
    }

    if (latestUser) {
      const content = storageContentOf(latestUser);
      const clientMessageId = typeof latestUser.id === "string" ? latestUser.id : undefined;
      const latestPersisted = persisted.at(-1);
      const alreadyPersisted = clientMessageId
        ? persisted.some((message) => message.clientMessageId === clientMessageId)
        : latestPersisted?.role === "user" && latestPersisted.content === content;
      if (content.trim() && !alreadyPersisted) {
        await client.mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "user", content, clientMessageId });
        persisted = await client.query(api.aiChat.listMessages, { companyId, sessionId });
      }
    }

    const modelMessages = persisted.map(toModelMessage);
    if (latestUser && latestHasAttachment) {
      const clientMessageId = typeof latestUser.id === "string" ? latestUser.id : undefined;
      const index = clientMessageId ? persisted.findIndex((message) => message.clientMessageId === clientMessageId) : persisted.length - 1;
      if (index >= 0) modelMessages[index] = latestUser;
      else modelMessages.push(latestUser);
    }

    const result = streamText({
      model: modelFor(routing, env.data),
      system: CENDRO_AI_SYSTEM_PROMPT,
      messages: await convertToModelMessages(modelMessages as any),
      providerOptions: providerOptionsFor(routing),
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      prepareStep: ({ stepNumber }) => stepNumber >= FINAL_ANSWER_STEP ? { activeTools: [], toolChoice: "none" as const } : undefined,
      tools: buildCendroAiTools(agentContext) as any,
      maxOutputTokens: 8192,
      maxRetries: 1,
      abortSignal: req.signal,
    });

    return result.toUIMessageStreamResponse({
      originalMessages: modelMessages as any,
      sendReasoning: true,
      headers: { "X-Accel-Buffering": "no" },
      onError: () => "Cendro AI could not complete that request.",
      onFinish: async ({ responseMessage, isAborted, finishReason }) => {
        if (isAborted || finishReason === "length" || finishReason === "error" || !finalTextOfAssistantMessage(responseMessage).trim()) return;
        const content = serializeAssistantMessage(responseMessage);
        await client.mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "assistant", content });
      },
    });
  } catch {
    return Response.json({ error: "Cendro AI could not complete that request." }, { status: 500 });
  }
}
