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
const titleModel = "alibaba/qwen3.5-flash";
const uppercaseWords = new Set(["ai", "api", "auth", "crm", "csv", "hr", "id", "ids", "jd", "pdf", "qa", "seo", "sop", "sql", "ui", "ux"]);
const fallbackStopWords = new Set(["a", "about", "add", "am", "an", "and", "are", "as", "at", "be", "build", "by", "can", "could", "create", "did", "do", "does", "for", "from", "get", "give", "had", "has", "have", "hello", "help", "hey", "hi", "how", "i", "in", "into", "is", "it", "just", "like", "make", "me", "my", "need", "of", "on", "or", "please", "show", "tell", "that", "the", "this", "to", "use", "using", "want", "what", "when", "where", "which", "who", "why", "with", "would", "write", "you", "your"]);

function titleCase(value: string) {
  return value.split(" ").filter(Boolean).map((word) => {
    const lower = word.toLowerCase();
    if (uppercaseWords.has(lower)) return lower.toUpperCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(" ");
}

function normalizedWords(value: string) {
  return value.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim().toLowerCase().split(" ").filter(Boolean);
}

function cleanTitle(value: string) {
  const title = value.replace(/^\s*(?:chat title|session title|title)\s*:\s*/i, "").replace(/["'`*_#\[\]{}<>]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/-/g, " ").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const words = title.split(" ").filter(Boolean).slice(0, 5);
  return titleCase(words.join(" ")).slice(0, 60);
}

function fallbackTitle(message: string) {
  const normalized = message.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "New Session";
  if (/\b(?:jd|recurring)\b.*\btasks?\b|\btasks?\b.*\b(?:jd|recurring)\b/i.test(normalized)) return "JD Task Summary";
  if (/\bone[-\s]?time\b.*\btasks?\b|\btasks?\b.*\bone[-\s]?time\b/i.test(normalized)) return "One Time Tasks";
  if (/\b(?:chat|session)\b.*\btitle\b|\btitle\b.*\b(?:chat|session)\b/i.test(normalized)) return "Session Title Generation";
  if (/\bconvex\b.*\bauth\b|\bauth\b.*\bconvex\b/i.test(normalized)) return "Convex Auth Debugging";
  if (/\bdashboard\b.*\b(?:design|notion|polish|ui|ugly)\b|\b(?:design|notion|polish|ui|ugly)\b.*\bdashboard\b/i.test(normalized)) return "Dashboard UI Polish";
  if (/\btasks?\b|\btodos?\b/i.test(normalized)) return "Task Summary";

  const keywords = normalizedWords(normalized).filter((word) => word.length > 1 && !fallbackStopWords.has(word));
  const uniqueKeywords = [...new Set(keywords)].slice(0, 4);
  if (uniqueKeywords.length >= 2) return titleCase(uniqueKeywords.join(" "));
  if (uniqueKeywords.length === 1) return titleCase(`${uniqueKeywords[0]} Chat`);
  return "New Session";
}

function isCopiedPrefix(title: string, message: string) {
  const titleWords = normalizedWords(title);
  if (titleWords.length === 0) return false;
  const messagePrefix = normalizedWords(message).slice(0, titleWords.length);
  return titleWords.every((word, index) => word === messagePrefix[index]);
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
        model: gateway(titleModel),
        system: `You are a chat title generator.
Return only the final title.
Rules:
- 1-5 words.
- Title Case.
- Specific noun phrase summarizing the user's intent.
- No quotes, punctuation, markdown, labels, or explanation.
- Do not copy the user's opening words.

Examples:
User: Hello, what jd tasks do i have?
Title: JD Task Summary
User: I want you to improve the session title generation system prompt for the AI Chat Panel.
Title: Session Title Generation
User: can you debug why convex auth fails on deploy?
Title: Convex Auth Debugging`,
        prompt: `User message:\n${first.slice(0, 1200)}\n\nTitle:`,
        maxOutputTokens: 20,
        temperature: 0,
        maxRetries: 0,
      });
      const candidate = cleanTitle(result.text);
      const wordCount = candidate.split(" ").filter(Boolean).length;
      if (wordCount >= 1 && wordCount <= 5 && !isCopiedPrefix(candidate, first)) title = candidate;
    } catch {
      title = fallback;
    }
  }

  const saved = await client.mutation(api.aiChat.setSessionTitle, { companyId, sessionId, title: title || "New Session" });
  return Response.json({ title: saved });
}
