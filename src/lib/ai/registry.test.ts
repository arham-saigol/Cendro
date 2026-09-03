import { describe, expect, test, vi } from "vitest";
import { cendroAiToolDefinitions, type CendroAiToolContext } from "./registry";
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
    capabilities: new Set(["tasks:one_time:create", "tasks:jd:create", "tasks:comment"] as const),
    refs: new Map(),
    counters: { task: 0, sop: 0, member: 0 },
    ...overrides,
  };
}

describe("AI tool registry task notes", () => {
  test("create_one_time_task accepts notes and forwards to mutation", async () => {
    const def = cendroAiToolDefinitions.find((t) => t.name === "create_one_time_task")!;
    expect(def).toBeDefined();

    const parsed: any = def.inputSchema.parse({
      title: "Clean kitchen",
      description: "Detailed description",
      notes: "Do not use bleach",
      priority: "high",
    });
    expect(parsed.notes).toBe("Do not use bleach");

    const ctx = mockContext();
    (ctx.client.mutation as any).mockResolvedValueOnce({
      id: "task-1",
      title: "Clean kitchen",
      notes: "Do not use bleach",
      status: "due",
      dueAt: null,
      priority: "high",
      assignees: [],
    });

    const res = await def.execute(parsed, ctx);
    expect(res).toMatchObject({
      ok: true,
      task: {
        title: "Clean kitchen",
        notes: "Do not use bleach",
        status: "due",
      },
    });
    expect(ctx.client.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notes: "Do not use bleach" })
    );
  });

  test("create_jd_task accepts notes and forwards to mutation", async () => {
    const def = cendroAiToolDefinitions.find((t) => t.name === "create_jd_task")!;
    expect(def).toBeDefined();

    const parsed: any = def.inputSchema.parse({
      title: "Daily inspection",
      notes: "Check refrigeration units",
      recurrence: "daily",
    });
    expect(parsed.notes).toBe("Check refrigeration units");

    const ctx = mockContext();
    (ctx.client.mutation as any).mockResolvedValueOnce({
      kind: "jd",
      id: "task-2",
      title: "Daily inspection",
      notes: "Check refrigeration units",
      status: "due",
      dueAt: null,
      assignees: [],
    });

    const res = await def.execute(parsed, ctx);
    expect(res).toMatchObject({
      ok: true,
      task: {
        title: "Daily inspection",
        notes: "Check refrigeration units",
      },
    });
    expect(ctx.client.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notes: "Check refrigeration units" })
    );
  });

  test("get_task_detail and list_tasks carry notes through taskOut", async () => {
    const listDef = cendroAiToolDefinitions.find((t) => t.name === "list_tasks")!;
    const getDetailDef = cendroAiToolDefinitions.find((t) => t.name === "get_task_detail")!;

    const ctx = mockContext();
    (ctx.client.query as any).mockResolvedValueOnce([
      {
        kind: "one_time",
        id: "task-10",
        title: "Task with notes",
        notes: "Remember safety goggles",
        status: "due",
      },
    ]);

    const listRes = await listDef.execute({ status: "all", limit: 10 }, ctx);
    expect(listRes).toMatchObject({
      ok: true,
      tasks: [
        expect.objectContaining({
          title: "Task with notes",
          notes: "Remember safety goggles",
        }),
      ],
    });

    const taskRef = (listRes as any).tasks[0].ref;

    (ctx.client.query as any).mockResolvedValueOnce({
      kind: "one_time",
      id: "task-10",
      title: "Task with notes",
      description: "A description",
      notes: "Remember safety goggles",
      status: "due",
      comments: [],
    });

    const detailRes = await getDetailDef.execute({ taskRef }, ctx);
    expect(detailRes).toMatchObject({
      ok: true,
      task: {
        title: "Task with notes",
        description: "A description",
        notes: "Remember safety goggles",
      },
    });
  });
});
