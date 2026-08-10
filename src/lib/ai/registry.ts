import { tool } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Capability, Role } from "@/lib/permissions";
import { cendroAiActivityLabels, type CendroAiToolName } from "./activity";
import { firecrawlFetch, firecrawlSearch } from "./web";

export type CendroAiPermissionRequirement = "member" | Capability | Capability[];
export type CendroAiRiskLevel = "read" | "write" | "external";
export type CendroAiActivity = { toolName: CendroAiToolName; label: string };
export type CendroAiToolResult = { ok: true; [key: string]: unknown } | { ok: false; message: string };

type RefKind = "task" | "sop" | "member";
type RefValue = { kind: RefKind; id: string; meta?: Record<string, unknown> };

export type CendroAiToolContext = {
  client: ConvexHttpClient;
  companyId: Id<"companies">;
  sessionId: Id<"aiChatSessions">;
  membershipId: Id<"companyMemberships">;
  role: Role;
  capabilities: Set<Capability>;
  refs: Map<string, RefValue>;
  counters: Record<RefKind, number>;
};

export type CendroAiToolDefinition<Input extends z.ZodType = z.ZodType> = {
  name: CendroAiToolName;
  description: string;
  inputSchema: Input;
  activityLabel: string;
  permission: CendroAiPermissionRequirement;
  risk: CendroAiRiskLevel;
  execute: (input: any, ctx: CendroAiToolContext) => Promise<CendroAiToolResult>;
};

class AiToolDenied extends Error {}
class AiToolNotFound extends Error {}

const priority = z.enum(["low", "medium", "high"]);
const recurrence = z.enum(["daily", "every_other_day", "weekly", "semimonthly", "monthly", "semiannually", "annually"]);
const taskRef = z.string().regex(/^task_\d+$/);
const memberRef = z.string().regex(/^member_\d+$/);
const sopRef = z.string().regex(/^sop_\d+$/);

function hasPermission(ctx: CendroAiToolContext, requirement: CendroAiPermissionRequirement) {
  if (requirement === "member") return true;
  if (Array.isArray(requirement)) return requirement.some((capability) => ctx.capabilities.has(capability));
  return ctx.capabilities.has(requirement);
}

function ensurePermission(ctx: CendroAiToolContext, requirement: CendroAiPermissionRequirement) {
  if (!hasPermission(ctx, requirement)) throw new AiToolDenied("This action is not available with your current permissions.");
}

function refFor(ctx: CendroAiToolContext, kind: RefKind, id: string, meta?: Record<string, unknown>) {
  for (const [ref, value] of ctx.refs) if (value.kind === kind && value.id === id) return ref;
  ctx.counters[kind] += 1;
  const ref = `${kind}_${ctx.counters[kind]}`;
  ctx.refs.set(ref, { kind, id, meta });
  return ref;
}

function resolveRef(ctx: CendroAiToolContext, ref: string, kind: RefKind) {
  const value = ctx.refs.get(ref);
  if (!value || value.kind !== kind) throw new AiToolNotFound("I can’t find that referenced item in this chat turn. Please ask me to list or search for it first.");
  return value;
}

function compactText(value?: string | null, max = 700) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeError(error: unknown) {
  if (error instanceof AiToolDenied || error instanceof AiToolNotFound) return error.message;
  const message = error instanceof Error ? error.message : "The requested action could not be completed.";
  if (/access|permission|sign in|not found|scope|assign/i.test(message)) return "I can’t access or change that item with your current permissions.";
  return "The requested action could not be completed.";
}

function taskOut(ctx: CendroAiToolContext, row: any) {
  const kind = row.kind === "jd" ? "jd" : "one_time";
  return {
    ref: refFor(ctx, "task", `${kind}:${row.id}`, { kind }),
    kind,
    title: row.title,
    status: row.status,
    dueAt: row.dueAt ?? null,
    priority: row.priority ?? null,
    assignees: (row.assignees ?? []).map((assignee: any) => ({ name: assignee.name, role: assignee.role })),
  };
}

function memberOut(ctx: CendroAiToolContext, row: any) {
  return { ref: refFor(ctx, "member", row.membershipId), name: row.name, email: row.email, role: row.role };
}

function sopOut(ctx: CendroAiToolContext, row: any, includeContent = false) {
  return {
    ref: refFor(ctx, "sop", row.id),
    title: row.title,
    scopeType: row.scopeType,
    excerpt: compactText(row.excerpt ?? row.content, 600),
    ...(includeContent ? { content: compactText(row.content, 5000) } : {}),
  };
}

export async function createCendroAiContext(input: { client: ConvexHttpClient; companyId: Id<"companies">; sessionId: Id<"aiChatSessions"> }): Promise<CendroAiToolContext> {
  const authz = await input.client.query(api.aiChat.authorizeSessionForAgent, { companyId: input.companyId, sessionId: input.sessionId });
  return {
    client: input.client,
    companyId: input.companyId,
    sessionId: input.sessionId,
    membershipId: authz.membershipId,
    role: authz.role,
    capabilities: new Set(authz.capabilities as Capability[]),
    refs: new Map(),
    counters: { task: 0, sop: 0, member: 0 },
  };
}

export const cendroAiToolDefinitions: CendroAiToolDefinition[] = [
  {
    name: "get_workspace_context",
    description: "Get the current user's role, capability summary, workspace name, and safe scope summary. Use before answering questions about permissions or scope.",
    inputSchema: z.object({}),
    activityLabel: cendroAiActivityLabels.get_workspace_context,
    permission: "member",
    risk: "read",
    execute: async (_input, ctx) => ({ ok: true, context: await ctx.client.query(api.aiWorkspace.context, { companyId: ctx.companyId }) }),
  },
  {
    name: "list_tasks",
    description: "List tasks visible to the current user. Returns ephemeral task refs for follow-up task actions.",
    inputSchema: z.object({ status: z.enum(["all", "due", "overdue", "done"]).default("all"), limit: z.number().int().min(1).max(30).default(12) }),
    activityLabel: cendroAiActivityLabels.list_tasks,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => {
      const rows = await ctx.client.query(api.tasks.aiListVisible, { companyId: ctx.companyId, status: input.status, limit: input.limit });
      return { ok: true, tasks: rows.map((row: any) => taskOut(ctx, row)), truncated: rows.length >= input.limit };
    },
  },
  {
    name: "get_task_detail",
    description: "Read details for a visible task from a task ref returned by list_tasks.",
    inputSchema: z.object({ taskRef }),
    activityLabel: cendroAiActivityLabels.get_task_detail,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => {
      const ref = resolveRef(ctx, input.taskRef, "task");
      const [kind, id] = ref.id.split(":") as ["jd" | "one_time", string];
      const row = await ctx.client.query(api.tasks.aiGetDetail, { companyId: ctx.companyId, kind, taskId: id });
      return { ok: true, task: { ...taskOut(ctx, row), description: compactText(row.description, 1500), comments: row.comments } };
    },
  },
  {
    name: "list_assignable_users",
    description: "List people the current user can assign tasks to. Use this before creating tasks. Returns ephemeral member refs.",
    inputSchema: z.object({ kind: z.enum(["jd", "one_time"]) }),
    activityLabel: cendroAiActivityLabels.list_assignable_users,
    permission: ["tasks:jd:create", "tasks:one_time:create"],
    risk: "read",
    execute: async (input, ctx) => ({ ok: true, people: (await ctx.client.query(api.tasks.aiAssignableUsers, { companyId: ctx.companyId, kind: input.kind })).map((row: any) => memberOut(ctx, row)) }),
  },
  {
    name: "create_one_time_task",
    description: "Create a one-time task after the user explicitly asks for it. Use member refs from list_assignable_users; if absent, ask one clarification.",
    inputSchema: z.object({ title: z.string().min(1).max(160), description: z.string().max(2000).optional(), dueDateMs: z.number().int().positive().optional(), assigneeRefs: z.array(memberRef).max(10).default([]), priority: priority.default("medium") }),
    activityLabel: cendroAiActivityLabels.create_one_time_task,
    permission: "tasks:one_time:create",
    risk: "write",
    execute: async (input, ctx) => {
      const assigneeMembershipIds = input.assigneeRefs.map((ref: string) => resolveRef(ctx, ref, "member").id as Id<"companyMemberships">);
      const row = await ctx.client.mutation(api.tasks.aiCreateOneTime, { companyId: ctx.companyId, title: input.title, description: input.description, dueDate: input.dueDateMs, assigneeMembershipIds, priority: input.priority });
      return { ok: true, task: taskOut(ctx, row) };
    },
  },
  {
    name: "create_jd_task",
    description: "Create a recurring JD task after explicit user intent. Use member refs from list_assignable_users; if absent, ask one clarification.",
    inputSchema: z.object({ title: z.string().min(1).max(160), description: z.string().max(2000).optional(), recurrence, assigneeRefs: z.array(memberRef).max(10).default([]) }),
    activityLabel: cendroAiActivityLabels.create_jd_task,
    permission: "tasks:jd:create",
    risk: "write",
    execute: async (input, ctx) => {
      const assigneeMembershipIds = input.assigneeRefs.map((ref: string) => resolveRef(ctx, ref, "member").id as Id<"companyMemberships">);
      const row = await ctx.client.mutation(api.tasks.aiCreateJd, { companyId: ctx.companyId, title: input.title, description: input.description, recurrence: input.recurrence, assigneeMembershipIds });
      return { ok: true, task: taskOut(ctx, row) };
    },
  },
  {
    name: "complete_task",
    description: "Mark a visible task complete when the user explicitly asks. Requires a task ref from list_tasks or get_task_detail.",
    inputSchema: z.object({ taskRef, note: z.string().max(1000).optional() }),
    activityLabel: cendroAiActivityLabels.complete_task,
    permission: ["tasks:jd:update:any", "tasks:jd:update:managed", "tasks:jd:update:self", "tasks:one_time:update:any", "tasks:one_time:update:managed", "tasks:one_time:update:self"],
    risk: "write",
    execute: async (input, ctx) => {
      const ref = resolveRef(ctx, input.taskRef, "task");
      const [kind, id] = ref.id.split(":") as ["jd" | "one_time", string];
      const row = await ctx.client.mutation(api.tasks.aiComplete, { companyId: ctx.companyId, kind, taskId: id, note: input.note });
      return { ok: true, task: taskOut(ctx, row) };
    },
  },
  {
    name: "add_task_comment",
    description: "Add a comment to a visible task when explicitly requested. Requires a task ref.",
    inputSchema: z.object({ taskRef, body: z.string().min(1).max(2000) }),
    activityLabel: cendroAiActivityLabels.add_task_comment,
    permission: "tasks:comment",
    risk: "write",
    execute: async (input, ctx) => {
      const ref = resolveRef(ctx, input.taskRef, "task");
      const [kind, id] = ref.id.split(":") as ["jd" | "one_time", string];
      await ctx.client.mutation(api.tasks.aiAddComment, { companyId: ctx.companyId, kind, taskId: id, body: input.body });
      return { ok: true, message: "Comment added." };
    },
  },
  {
    name: "search_sops",
    description: "Search SOPs visible to the current user. Returns ephemeral SOP refs for follow-up reads.",
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    activityLabel: cendroAiActivityLabels.search_sops,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => ({ ok: true, sops: (await ctx.client.query(api.sops.aiSearch, { companyId: ctx.companyId, query: input.query })).map((row: any) => sopOut(ctx, row)) }),
  },
  {
    name: "get_sop",
    description: "Read a visible SOP by SOP ref returned from search_sops.",
    inputSchema: z.object({ sopRef }),
    activityLabel: cendroAiActivityLabels.get_sop,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => {
      const ref = resolveRef(ctx, input.sopRef, "sop");
      return { ok: true, sop: sopOut(ctx, await ctx.client.query(api.sops.aiGet, { companyId: ctx.companyId, sopId: ref.id as Id<"sops"> }), true) };
    },
  },
  {
    name: "create_sop",
    description: "Create a company-wide SOP after explicit user intent. Do not use for destructive or permission-changing actions.",
    inputSchema: z.object({ title: z.string().min(1).max(160), content: z.string().min(1).max(8000) }),
    activityLabel: cendroAiActivityLabels.create_sop,
    permission: "sops:create",
    risk: "write",
    execute: async (input, ctx) => {
      const row = await ctx.client.mutation(api.sops.aiCreate, { companyId: ctx.companyId, title: input.title, content: input.content });
      return { ok: true, sop: sopOut(ctx, row, true) };
    },
  },
  {
    name: "list_people_in_scope",
    description: "List people visible in the current user's scope. Use for non-sensitive workspace people questions, not role changes.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    activityLabel: cendroAiActivityLabels.list_people_in_scope,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => ({ ok: true, people: (await ctx.client.query(api.aiWorkspace.peopleInScope, { companyId: ctx.companyId, limit: input.limit })).map((row: any) => memberOut(ctx, row)) }),
  },
  {
    name: "get_analytics_summary",
    description: "Get a permission-scoped analytics summary for this workspace.",
    inputSchema: z.object({}),
    activityLabel: cendroAiActivityLabels.get_analytics_summary,
    permission: ["analytics:view:company", "analytics:view:managed_scope", "analytics:view:self"],
    risk: "read",
    execute: async (_input, ctx) => ({ ok: true, summary: await ctx.client.query(api.analytics.aiSummary, { companyId: ctx.companyId }) }),
  },
  {
    name: "get_performance_summary",
    description: "Get permission-scoped task performance summary. Company for admins, managed scope for managers, self for employees.",
    inputSchema: z.object({}),
    activityLabel: cendroAiActivityLabels.get_performance_summary,
    permission: ["analytics:view:company", "analytics:view:managed_scope", "analytics:view:self"],
    risk: "read",
    execute: async (_input, ctx) => ({ ok: true, summary: await ctx.client.query(api.aiWorkspace.performanceSummary, { companyId: ctx.companyId }) }),
  },
  {
    name: "web_search",
    description: "Search the public web for external or current facts. Never use for Cendro workspace data.",
    inputSchema: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(5).default(5) }),
    activityLabel: cendroAiActivityLabels.web_search,
    permission: "member",
    risk: "external",
    execute: async (input) => firecrawlSearch(input),
  },
  {
    name: "web_fetch",
    description: "Fetch readable markdown from a public external web page. Never fetch private, internal, or Cendro app URLs.",
    inputSchema: z.object({ url: z.string().url().max(1000) }),
    activityLabel: cendroAiActivityLabels.web_fetch,
    permission: "member",
    risk: "external",
    execute: async (input) => firecrawlFetch(input),
  },
];

export function buildCendroAiTools(ctx: CendroAiToolContext) {
  return Object.fromEntries(cendroAiToolDefinitions.map((def) => [def.name, tool({
    description: `${def.description} Activity label: ${def.activityLabel}.`,
    inputSchema: def.inputSchema,
    execute: async (input) => {
      try {
        ensurePermission(ctx, def.permission);
        return await def.execute(input as never, ctx);
      } catch (error) {
        return { ok: false, message: safeError(error) } satisfies CendroAiToolResult;
      }
    },
  })]));
}
