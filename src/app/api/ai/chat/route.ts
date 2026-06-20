import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { gateway } from "@ai-sdk/gateway";
import { convertToModelMessages, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import type { Id, TableNames } from "../../../../../convex/_generated/dataModel";
import { serverEnv } from "@/lib/env";

const idSchema = <Table extends TableNames>() => z.custom<Id<Table>>((value) => typeof value === "string");
const requestSchema = z.object({ messages: z.array(z.any()), companyId: idSchema<"companies">(), sessionId: idSchema<"aiChatSessions">() });
const assigneeIdsSchema = z.array(idSchema<"companyMemberships">());

function textOf(message: any) {
  if (typeof message.content === "string") return message.content;
  return message.parts?.map((part: any) => part.type === "text" ? part.text : "").join("") ?? "";
}
function toUiMessage(row: { _id: string; role: "user" | "assistant" | "tool"; content: string }) {
  return { id: row._id, role: row.role, parts: [{ type: "text", text: row.content }] };
}

export async function POST(req: Request) {
  const env = serverEnv();
  const parsed = requestSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: "Invalid request body" }, { status: 400 });
  const { messages, companyId, sessionId } = parsed.data;
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  if (!token) return new Response("Missing Convex auth token", { status: 401 });

  const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
  client.setAuth(token);
  const common = { companyId };
  const persisted = await client.query(api.aiChat.listMessages, { companyId, sessionId });
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (latestUser) {
    const content = textOf(latestUser);
    const clientMessageId = typeof latestUser.id === "string" ? latestUser.id : undefined;
    const latestPersisted = persisted.at(-1);
    const alreadyPersisted = clientMessageId
      ? persisted.some((message) => message.clientMessageId === clientMessageId)
      : latestPersisted?.role === "user" && latestPersisted.content === content;
    if (content.trim() && !alreadyPersisted) {
      await client.mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "user", content, clientMessageId });
    }
  }
  const modelMessages = messages.length > persisted.length ? messages : persisted.map(toUiMessage);

  const result = streamText({
    model: gateway(env.AI_MODEL as any),
    system: "You are Cendro's internal assistant. Use tools for tasks, SOPs, and analytics. Never infer or expose data outside the user's permission scope. If a task creation tool needs assigneeMembershipIds, call listAssignableUsers first. Be concise and Notion-like.",
    messages: await convertToModelMessages(modelMessages),
    stopWhen: stepCountIs(5),
    tools: {
      listAssignableUsers: tool({ description: "List users the current user can assign tasks to, including membership IDs needed by creation tools.", inputSchema: z.object({ kind: z.enum(["jd", "one_time"]) }), execute: async ({ kind }) => client.query(api.tasks.assignableUsers, { ...common, kind }) }),
      listAccessibleTasks: tool({ description: "List tasks the current user can access.", inputSchema: z.object({}), execute: async () => client.query(api.tasks.accessibleTasksForAi, { ...common }) }),
      listOverdueTasks: tool({ description: "List overdue tasks within current permission scope.", inputSchema: z.object({}), execute: async () => client.query(api.tasks.accessibleTasksForAi, { ...common, overdueOnly: true }) }),
      searchAccessibleSops: tool({ description: "Semantically search SOPs visible to the current user.", inputSchema: z.object({ query: z.string() }), execute: async ({ query }) => client.action(api.sops.semanticSearchAccessible, { ...common, query }) }),
      createJdTask: tool({ description: "Create a JD recurring task if permitted.", inputSchema: z.object({ title: z.string(), assigneeMembershipIds: assigneeIdsSchema, recurrence: z.enum(["daily", "every_other_day", "weekly", "every_two_weeks", "monthly", "semiannually", "annually"]) }), execute: async (i) => client.mutation(api.tasks.createJd, { ...common, title: i.title, description: "Created by AI", recurrence: i.recurrence, startDate: Date.now(), assigneeMembershipIds: i.assigneeMembershipIds, priority: "medium" }) }),
      createOneTimeTask: tool({ description: "Create a one-time task if permitted.", inputSchema: z.object({ title: z.string(), assigneeMembershipIds: assigneeIdsSchema, dueDate: z.coerce.date() }), execute: async (i) => client.mutation(api.tasks.createOneTime, { ...common, title: i.title, description: "Created by AI", dueDate: i.dueDate.getTime(), assigneeMembershipIds: i.assigneeMembershipIds, priority: "medium" }) }),
      createSop: tool({ description: "Create a company-wide SOP if permitted.", inputSchema: z.object({ title: z.string(), content: z.string() }), execute: async (i) => client.mutation(api.sops.create, { ...common, title: i.title, content: i.content, scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] }) }),
      getAnalyticsSummary: tool({ description: "Get analytics summary within current scope.", inputSchema: z.object({}), execute: async () => client.query(api.analytics.summary, { ...common }) }),
      addTaskComment: tool({ description: "Add a comment to a task if permitted.", inputSchema: z.object({ taskType: z.enum(["jd", "one_time"]), taskId: z.string(), body: z.string() }), execute: async (i) => client.mutation(api.tasks.addComment, { ...common, ...i }) }),
    },
  });

  return result.toUIMessageStreamResponse({
    originalMessages: modelMessages as any,
    onFinish: async ({ responseMessage }) => {
      const content = textOf(responseMessage);
      if (content.trim()) await client.mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "assistant", content });
    },
  });
}
