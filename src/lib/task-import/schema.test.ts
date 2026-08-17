import { describe, expect, test } from "vitest";
import { taskImportDraftSchema } from "./schema";

describe("task import schema", () => {
  test("rejects fields from the wrong task kind", () => {
    expect(() => taskImportDraftSchema.parse({
      rowKey: "Tasks:2",
      sourceSheet: "Tasks",
      sourceRow: 2,
      source: "cendro",
      kind: "jd",
      reference: null,
      title: "Task",
      description: null,
      recurrence: null,
      dueDate: Date.now(),
      priority: null,
      time: null,
      quantity: null,
      rawAssigneeText: "",
      assigneeEmails: [],
      presentFields: [],
      warnings: [],
    })).toThrow();
  });
});
