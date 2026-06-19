import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { gateway } from "@ai-sdk/gateway";
import { convertToModelMessages, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import { serverEnv } from "@/lib/env";

export async function POST(req: Request) {
  const env = serverEnv();
  const { messages, companyId } = await req.json();
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  if (!token) return new Response("Missing Convex auth token", { status: 401 });

  const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
  client.setAuth(token);
  const common = { companyId: companyId as any };

  const result = streamText({
    model: gateway(env.AI_MODEL as any),
    system: "You are Cendro's internal assistant. Use tools for tasks, SOPs, and analytics. Never infer or expose data outside the user's permission scope. If a task creation tool needs assigneeMembershipIds, call listAssignableUsers first. Be concise and Notion-like.",
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(5),
    tools: {
      listAssignableUsers: tool({ description: "List users the current user can assign tasks to, including membership IDs needed by creation tools.", inputSchema: z.object({ kind: z.enum(["jd", "one_time"]) }), execute: async ({ kind }) => client.query(api.tasks.assignableUsers, { ...common, kind }) }),
      listAccessibleTasks: tool({ description: "List tasks the current user can access.", inputSchema: z.object({}), execute: async () => client.query(api.tasks.accessibleTasksForAi, { ...common }) }),
      listOverdueTasks: tool({ description: "List overdue tasks within current permission scope.", inputSchema: z.object({}), execute: async () => client.query(api.tasks.accessibleTasksForAi, { ...common, overdueOnly: true }) }),
      searchAccessibleSops: tool({ description: "Search SOPs visible to the current user.", inputSchema: z.object({ query: z.string() }), execute: async ({ query }) => client.query(api.sops.searchAccessible, { ...common, query }) }),
      createJdTask: tool({ description: "Create a JD recurring task if permitted.", inputSchema: z.object({ title: z.string(), assigneeMembershipIds: z.array(z.string()), recurrence: z.enum(["daily", "every_other_day", "weekly", "every_two_weeks", "monthly", "semiannually", "annually"]) }), execute: async (i) => client.mutation(api.tasks.createJd, { ...common, title: i.title, description: "Created by AI", recurrence: i.recurrence, startDate: Date.now(), assigneeMembershipIds: i.assigneeMembershipIds as any, priority: "medium" }) }),
      createOneTimeTask: tool({ description: "Create a one-time task if permitted.", inputSchema: z.object({ title: z.string(), assigneeMembershipIds: z.array(z.string()), dueDate: z.string() }), execute: async (i) => client.mutation(api.tasks.createOneTime, { ...common, title: i.title, description: "Created by AI", dueDate: new Date(i.dueDate).getTime(), assigneeMembershipIds: i.assigneeMembershipIds as any, priority: "medium" }) }),
      createSop: tool({ description: "Create a company-wide SOP if permitted.", inputSchema: z.object({ title: z.string(), content: z.string() }), execute: async (i) => client.mutation(api.sops.create, { ...common, title: i.title, content: i.content, scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] }) }),
      getAnalyticsSummary: tool({ description: "Get analytics summary within current scope.", inputSchema: z.object({}), execute: async () => client.query(api.analytics.summary, { ...common }) }),
      addTaskComment: tool({ description: "Add a comment to a task if permitted.", inputSchema: z.object({ taskType: z.enum(["jd", "one_time"]), taskId: z.string(), body: z.string() }), execute: async (i) => client.mutation(api.tasks.addComment, { ...common, ...i }) }),
    },
  });

  return result.toUIMessageStreamResponse();
}
