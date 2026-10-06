import { describe, expect, test } from "vitest";
import { taskImportDraftSchema } from "./schema";

describe("task import schema", () => {
  test("rejects fields from the wrong task kind", () => {
    const result = taskImportDraftSchema.safeParse({
      rowKey: "Tasks:2",
      sourceSheet: "Tasks",
      sourceRow: 2,
      source: "cendro",
      kind: "jd",
      reference: null,
      title: "Task",
      description: null,
      notes: null,
      recurrence: null,
      dueDate: Date.now(),
      priority: null,
      time: null,
      quantity: null,
      rawAssigneeText: "",
      assigneeEmails: [],
      status: null,
      isActive: null,
      presentFields: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((issue) => issue.path.join("."))).toContain("dueDate");
  });

  test("rejects an active state on one-time rows", () => {
    const result = taskImportDraftSchema.safeParse({
      rowKey: "Tasks:2",
      sourceSheet: "Tasks",
      sourceRow: 2,
      source: "cendro",
      kind: "one_time",
      reference: null,
      title: "Task",
      description: null,
      notes: null,
      recurrence: null,
      dueDate: null,
      priority: null,
      time: null,
      quantity: null,
      rawAssigneeText: "",
      assigneeEmails: [],
      status: null,
      isActive: false,
      presentFields: ["isActive"],
      warnings: [],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((issue) => issue.path.join("."))).toContain("isActive");
  });
});
