import { createFireworks } from "@ai-sdk/fireworks";
import { auth } from "@clerk/nextjs/server";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import type { Id, TableNames } from "../../../../../convex/_generated/dataModel";
import { AI_CHAT_MAX_REQUEST_BYTES, validateAiChatAttachments } from "@/lib/ai/attachments";
import { buildCendroAiTools, createCendroAiContext } from "@/lib/ai/registry";
import { consumeAiRateLimit } from "@/lib/ai/rate-limit";
import { readJsonRequest } from "@/lib/ai/request-body";
import { CENDRO_AI_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { safeAiChatServerEnv } from "@/lib/env";
import { finalTextOfAssistantMessage, serializeAssistantMessage, textOf, toModelMessage } from "@/lib/message-utils";
import { createAiPersistencePayload, signAiPersistencePayload } from "@/lib/ai-chat-hmac";

const idSchema = <Table extends TableNames>() => z.custom<Id<Table>>((value) => typeof value === "string");
const requestSchema = z.object({
  messages: z.array(z.any()).max(100),
  companyId: idSchema<"companies">(),
  sessionId: idSchema<"aiChatSessions">(),
});

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

const MAX_AGENT_STEPS = 16;
const FINAL_ANSWER_STEP = MAX_AGENT_STEPS - 1;

export async function POST(req: Request) {
  try {
    const env = safeAiChatServerEnv();
    if (!env.success) return Response.json({ error: "AI chat is not configured" }, { status: 503 });

    const { getToken } = await auth();
    const token = await getToken({ template: "convex" });
    if (!token) return Response.json({ error: "Missing Convex auth token" }, { status: 401 });

    const client = new ConvexHttpClient(env.data.NEXT_PUBLIC_CONVEX_URL);
    client.setAuth(token);
    const rateLimit = await consumeAiRateLimit(client, "ai-chat");
    if (!rateLimit.ok) return Response.json({ error: "Too many AI chat requests" }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } });

    const body = await readJsonRequest(req, AI_CHAT_MAX_REQUEST_BYTES);
    if (!body.ok) return Response.json({ error: body.reason === "too_large" ? "Chat request is too large" : "Invalid request body" }, { status: body.reason === "too_large" ? 413 : 400 });
    const parsed = requestSchema.safeParse(body.value);
    if (!parsed.success) return Response.json({ error: "Invalid request body" }, { status: 400 });
    const attachments = validateAiChatAttachments(parsed.data.messages);
    if (!attachments.ok) return Response.json({ error: attachments.error }, { status: 413 });

    const { messages, companyId, sessionId } = parsed.data;

    let agentContext;
    try {
      agentContext = await createCendroAiContext({ client, companyId, sessionId });
    } catch {
      return Response.json({ error: "Chat session not found" }, { status: 404 });
    }

    let persisted = await client.query(api.aiChat.listMessages, { companyId, sessionId });
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const latestHasAttachment = latestUser ? hasFileAttachment(latestUser) : false;

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

    const fireworks = createFireworks({ apiKey: env.data.FIREWORKS_API_KEY });
    const result = streamText({
      model: fireworks(env.data.AI_MODEL as any),
      system: CENDRO_AI_SYSTEM_PROMPT,
      messages: await convertToModelMessages(modelMessages as any),
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
        const secret = process.env.AI_CHAT_PERSISTENCE_SECRET;
        if (!secret) return;
        const timestamp = Date.now();
        const requestId = crypto.randomUUID();
        const payload = createAiPersistencePayload({
          companyId,
          sessionId,
          role: "assistant",
          timestamp,
          requestId,
          content,
        });
        const signature = await signAiPersistencePayload(secret, payload);
        await client.mutation(api.aiChat.persistServerMessage, {
          companyId,
          sessionId,
          role: "assistant",
          content,
          timestamp,
          requestId,
          signature,
        });
      },
    });
  } catch {
    return Response.json({ error: "Cendro AI could not complete that request." }, { status: 500 });
  }
}
