import { describe, expect, test, vi } from "vitest";
import { buildCendroAiTools, cendroAiToolDefinitions, type CendroAiToolContext } from "./registry";
import type { Id } from "../../../convex/_generated/dataModel";

function mockContext(overrides: Partial<CendroAiToolContext> = {}): CendroAiToolContext {
  return {
    client: {
      query: vi.fn(),
      mutation: vi.fn(),
    } as any,
    companyId: "company-1" as Id<"companies">,
    sessionId: "session-1" as Id<"aiChatSessions">,
    membershipId: "member-1" as Id<"companyMemberships">,
    role: "Admin",
    timeZone: "UTC",
    capabilities: new Set(["tasks:one_time:create", "tasks:jd:create", "tasks:comment", "sops:create"] as const),
    refs: new Map(),
    counters: { task: 0, sop: 0, member: 0, branch: 0, department: 0 },
    ...overrides,
  };
}

function defOf(name: string) {
  const def = cendroAiToolDefinitions.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def;
}

describe("AI tool registry", () => {
  test("create_task forwards notes and priority and returns the created task", async () => {
    const def = defOf("create_task");
    const parsed: any = def.inputSchema.parse({
      kind: "one_time",
      title: "Clean kitchen",
      notes: "Do not use bleach",
      priority: "critical",
      assigneeRefs: ["member_1"],
    });

    const ctx = mockContext();
    ctx.refs.set("member_1", { kind: "member", id: "member-1" });
    (ctx.client.mutation as any).mockResolvedValueOnce("task-1");
    (ctx.client.query as any).mockResolvedValueOnce({ kind: "one_time", id: "task-1", title: "Clean kitchen", notes: "Do not use bleach", status: "due", priority: "critical", assignees: [], comments: [] });

    const res = await def.execute(parsed, ctx);
    expect(res).toMatchObject({ ok: true, task: { title: "Clean kitchen", notes: "Do not use bleach", priority: "critical" } });
    expect(ctx.client.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ notes: "Do not use bleach", priority: "critical", assigneeMembershipIds: ["member-1"] }));
    expect(ctx.client.query).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "one_time", taskId: "task-1" }));
  });

  test("create_task requires a capability matching its kind", async () => {
    const def = defOf("create_task");
    const parsed: any = def.inputSchema.parse({ kind: "one_time", title: "Nope", assigneeRefs: ["member_1"] });
    const ctx = mockContext({ capabilities: new Set() });
    ctx.refs.set("member_1", { kind: "member", id: "member-1" });
    const tools = buildCendroAiTools(ctx);
    const res = await (tools.create_task.execute as any)(parsed);
    expect(res).toMatchObject({ ok: false });
    expect(ctx.client.mutation).not.toHaveBeenCalled();
  });

  test("create_task rejects a jd task without recurrence", async () => {
    const def = defOf("create_task");
    const parsed: any = def.inputSchema.parse({ kind: "jd", title: "Inspection", assigneeRefs: ["member_1"] });
    const ctx = mockContext();
    ctx.refs.set("member_1", { kind: "member", id: "member-1" });
    const tools = buildCendroAiTools(ctx);
    const res = await (tools.create_task.execute as any)(parsed);
    expect(res).toMatchObject({ ok: false });
    expect((res as any).message).toMatch(/recurrence/i);
    expect(ctx.client.mutation).not.toHaveBeenCalled();
  });

  test("create_task requires at least one assignee", () => {
    const def = defOf("create_task");
    expect(() => def.inputSchema.parse({ kind: "one_time", title: "Unassigned" })).toThrow();
  });

  test("list_tasks passes query and kind filters and carries notes through taskOut", async () => {
    const def = defOf("list_tasks");
    const ctx = mockContext();
    (ctx.client.query as any).mockResolvedValueOnce({
      rows: [{ kind: "one_time", id: "task-10", reference: "T-10", title: "Task with notes", notes: "Remember safety goggles", status: "due" }],
      truncated: false,
    });

    const res = await def.execute({ status: "all", kind: "one_time", query: "goggles", limit: 10 }, ctx);
    expect(res).toMatchObject({ ok: true, tasks: [expect.objectContaining({ title: "Task with notes", notes: "Remember safety goggles", reference: "T-10" })] });
    expect(ctx.client.query).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "one_time", search: "goggles" }));
  });

  test("get_task resolves the ref kind and returns detail", async () => {
    const listDef = defOf("list_tasks");
    const getDef = defOf("get_task");
    const ctx = mockContext();
    (ctx.client.query as any).mockResolvedValueOnce({ rows: [{ kind: "jd", id: "task-10", title: "Recurring", status: "due" }], truncated: false });
    const listRes: any = await listDef.execute({ status: "all", limit: 10 }, ctx);
    const taskRef = listRes.tasks[0].ref;

    (ctx.client.query as any).mockResolvedValueOnce({ kind: "jd", id: "task-10", title: "Recurring", description: "A description", status: "due", comments: [] });
    const res = await getDef.execute({ taskRef }, ctx);
    expect(res).toMatchObject({ ok: true, task: { title: "Recurring", description: "A description" } });
    expect(ctx.client.query).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: "jd", taskId: "task-10" }));
  });

  test("set_task_status is not gated on update capabilities", async () => {
    const ctx = mockContext({ capabilities: new Set() });
    ctx.refs.set("task_1", { kind: "task", id: "one_time:task-1" });
    (ctx.client.mutation as any).mockResolvedValueOnce({ kind: "one_time", id: "task-1", title: "Assigned task", status: "Completed", assignees: [] });

    const tools = buildCendroAiTools(ctx);
    const res = await (tools.set_task_status.execute as any)({ taskRef: "task_1", status: "completed" });
    expect(res).toMatchObject({ ok: true, task: { status: "Completed" } });
    expect(ctx.client.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "one_time", taskId: "task-1", status: "completed" }));
  });

  test("update_task routes to the kind-correct mutation and returns the updated row", async () => {
    const def = defOf("update_task");
    const ctx = mockContext();
    ctx.refs.set("task_1", { kind: "task", id: "one_time:task-1" });
    (ctx.client.mutation as any).mockResolvedValueOnce(null);
    (ctx.client.query as any).mockResolvedValueOnce({ kind: "one_time", id: "task-1", title: "Renamed", status: "due", assignees: [], comments: [] });

    const res = await def.execute({ taskRef: "task_1", title: "Renamed", dueDateMs: 123 }, ctx);
    expect(res).toMatchObject({ ok: true, task: { title: "Renamed" } });
    expect(ctx.client.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "Renamed", dueDate: 123 }));
  });

  test("update_task rejects a due date on a recurring task", async () => {
    const ctx = mockContext();
    ctx.refs.set("task_1", { kind: "task", id: "jd:task-1" });
    const tools = buildCendroAiTools(ctx);
    const res = await (tools.update_task.execute as any)({ taskRef: "task_1", dueDateMs: 123 });
    expect(res).toMatchObject({ ok: false });
    expect(ctx.client.mutation).not.toHaveBeenCalled();
  });

  test("delete_task routes to the kind-correct delete", async () => {
    const def = defOf("delete_task");
    const ctx = mockContext();
    ctx.refs.set("task_1", { kind: "task", id: "jd:task-9" });
    (ctx.client.mutation as any).mockResolvedValueOnce(null);

    const res = await def.execute({ taskRef: "task_1" }, ctx);
    expect(res).toMatchObject({ ok: true });
    expect(ctx.client.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ taskId: "task-9" }));
  });

  test("create_sop resolves a branch target ref into scope rows", async () => {
    const def = defOf("create_sop");
    const ctx = mockContext();
    ctx.refs.set("branch_1", { kind: "branch", id: "branch-1" });
    (ctx.client.mutation as any).mockResolvedValueOnce("sop-1");
    (ctx.client.query as any).mockResolvedValueOnce({ id: "sop-1", title: "Store SOP", content: "Body", scopeType: "branch", scopeTargetName: "Downtown" });

    const res = await def.execute({ title: "Store SOP", content: "Body", scopeType: "branch", targetRef: "branch_1" }, ctx);
    expect(res).toMatchObject({ ok: true, sop: { title: "Store SOP" } });
    expect(ctx.client.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scopeType: "branch", branchIds: ["branch-1"] }));
  });

  test("create_sop rejects a scoped SOP without a targetRef", async () => {
    const ctx = mockContext();
    const tools = buildCendroAiTools(ctx);
    const res = await (tools.create_sop.execute as any)({ title: "S", content: "B", scopeType: "branch" });
    expect(res).toMatchObject({ ok: false });
    expect(ctx.client.mutation).not.toHaveBeenCalled();
  });

  test("tool errors surface the ConvexError message to the agent", async () => {
    const ctx = mockContext();
    const failure = new Error("Uncaught ConvexError: Task not found.") as Error & { data?: unknown };
    failure.data = "Task not found.";
    (ctx.client.mutation as any).mockRejectedValueOnce(failure);
    ctx.refs.set("task_1", { kind: "task", id: "one_time:task-1" });

    const tools = buildCendroAiTools(ctx);
    const res = await (tools.delete_task.execute as any)({ taskRef: "task_1" });
    expect(res).toEqual({ ok: false, message: "Task not found." });
  });

  test("unresolved refs fail with a helpful message", async () => {
    const ctx = mockContext();
    const tools = buildCendroAiTools(ctx);
    const res = await (tools.get_task.execute as any)({ taskRef: "task_9" });
    expect(res).toMatchObject({ ok: false });
    expect((res as any).message).toMatch(/find that referenced item/i);
  });
});
