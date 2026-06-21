import { gateway } from "@ai-sdk/gateway";
import { auth } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import type { Id, TableNames } from "../../../../../convex/_generated/dataModel";
import { consumeAiRateLimit } from "@/lib/ai/rate-limit";
import { textOf } from "@/lib/message-utils";

const idSchema = <Table extends TableNames>() => z.custom<Id<Table>>((value) => typeof value === "string");
const requestSchema = z.object({ companyId: idSchema<"companies">(), sessionId: idSchema<"aiChatSessions">(), firstMessage: z.string().max(2000).optional() });

function cleanTitle(value: string) {
  const title = value.replace(/["'`*_#\[\]{}<>]/g, "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const words = title.split(" ").filter(Boolean).slice(0, 5);
  return words.join(" ").slice(0, 60);
}

function fallbackTitle(message: string) {
  const words = message.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 5);
  if (words.length >= 2) return words.join(" ");
  if (words.length === 1) return `${words[0]} Chat`;
  return "New Session";
}

function authorizeErrorResponse(error: unknown) {
  const anyError = error as { code?: string; data?: { code?: string; message?: string }; message?: string };
  const code = `${anyError.code ?? ""} ${anyError.data?.code ?? ""}`;
  const message = `${anyError.data?.message ?? ""} ${anyError.message ?? String(error)}`;
  if (/auth|sign in|access|permission|forbidden/i.test(`${code} ${message}`)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (/not found/i.test(message)) return Response.json({ error: "Chat session not found" }, { status: 404 });
  return Response.json({ error: "Could not authorize chat session" }, { status: 500 });
}

export async function POST(req: Request) {
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request body" }, { status: 400 });
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return Response.json({ error: "Convex is not configured" }, { status: 500 });

  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  if (!token) return new Response("Missing Convex auth token", { status: 401 });

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  const rateLimit = await consumeAiRateLimit(client, "ai-title");
  if (!rateLimit.ok) return Response.json({ error: "Too many title requests" }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } });
  const { companyId, sessionId } = parsed.data;
  try {
    await client.query(api.aiChat.authorizeSessionForAgent, { companyId, sessionId });
  } catch (error) {
    return authorizeErrorResponse(error);
  }

  const messages = await client.query(api.aiChat.listMessages, { companyId, sessionId });
  const first = parsed.data.firstMessage || textOf(messages.find((message) => message.role === "user") ?? null);
  const fallback = cleanTitle(fallbackTitle(first));
  let title = fallback;

  if (process.env.AI_GATEWAY_API_KEY && first.trim()) {
    try {
      const result = await generateText({
        model: gateway("deepseek/deepseek-v4-flash"),
        system: "Generate a concise 2-5 word chat title. Return only the title. No punctuation unless necessary.",
        prompt: first.slice(0, 1200),
        maxOutputTokens: 20,
      });
      const candidate = cleanTitle(result.text);
      if (candidate.split(" ").filter(Boolean).length >= 2 && candidate.split(" ").filter(Boolean).length <= 5) title = candidate;
    } catch {
      title = fallback;
    }
  }

  const saved = await client.mutation(api.aiChat.setSessionTitle, { companyId, sessionId, title: title || "New Session" });
  return Response.json({ title: saved });
}
