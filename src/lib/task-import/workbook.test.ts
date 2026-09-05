import readXlsxFile from "read-excel-file/browser";
import { describe, expect, test } from "vitest";
import {
  buildExportMetadata,
  formulaCellsInXml,
  duplicateReferences,
  exportTaskWorkbook,
  parseCendroWorkbookSheets,
  normalizeFrequency,
  normalizePriority,
  normalizeStatus,
  parseStrictDate,
  parseAssigneeEmails,
  protectFormulaText,
} from "./workbook";
import { referenceForKind } from "./schema";

describe("task workbook pure helpers", () => {
  test("normalizes canonical enum aliases and statuses", () => {
    expect(normalizeFrequency("Every other day")).toBe("every_other_day");
    expect(normalizeFrequency("qtr")).toBe("quarterly");
    expect(normalizeFrequency("bi-yearly")).toBe("semiannually");
    expect(normalizePriority("MED")).toBe("medium");
    expect(normalizePriority("urgent")).toBeNull();
    expect(normalizeStatus("Pending")).toBe("due");
    expect(normalizeStatus("In Progress")).toBe("in_progress");
    expect(normalizeStatus("Completed")).toBe("completed");
    expect(normalizeStatus("unknown")).toBeNull();
  });

  test("rejects ambiguous dates and accepts unambiguous dates", () => {
    expect(parseStrictDate("01/02/2026").error).toMatch(/Ambiguous/);
    const parsed = new Date(parseStrictDate("2026-02-01").value!);
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2026, 1, 1]);
    expect([parsed.getHours(), parsed.getMinutes(), parsed.getSeconds()]).toEqual([23, 59, 59]);
    expect(parseStrictDate("2026-02-01 25:00").error).toBe("Invalid due date.");
  });

  test("normalizes semicolon separated emails without fuzzy names", () => {
    expect(parseAssigneeEmails(" A@Example.com; b@example.com; ")).toEqual({ raw: "A@Example.com; b@example.com;", emails: ["a@example.com", "b@example.com"] });
  });

  test("protects formula-leading text and validates references", () => {
    expect(protectFormulaText("=1+1")).toBe("'=1+1");
    expect(referenceForKind("JD-001", "jd")).toEqual({ value: "JD-001" });
    expect(referenceForKind("JD-0001", "jd")).toEqual({ value: "JD-0001" });
    expect(referenceForKind("JD-10000", "jd")).toEqual({ value: "JD-10000" });
    expect(referenceForKind("TSK-001", "jd").error).toBeTruthy();
    expect(referenceForKind("OT-001", "jd").error).toBeTruthy();
    expect(referenceForKind("TSK-001", "one_time")).toEqual({ value: "TSK-001" });
    expect(referenceForKind("OT-0001", "one_time")).toEqual({ value: "OT-0001" });
    expect(referenceForKind("", "jd").error).toBe("Task code is required and must match JD-001.");
    expect(referenceForKind(null, "one_time").error).toBe("Task code is required and must match TSK-001.");
    expect(referenceForKind("INVALID", "jd").error).toBe("Code must match JD-001.");
    expect(referenceForKind("JD-1", "jd").error).toBe("Code must match JD-001.");
    expect(referenceForKind("JD-9007199254740992", "jd").error).toBe("Code must match JD-001.");
    expect(referenceForKind("JD-99999999999999999999", "jd").error).toBe("Code must match JD-001.");
  });

  test("finds duplicate workbook references", () => {
    expect(duplicateReferences([{ reference: "JD-001" }, { reference: "jd-001" }, { reference: null }])).toEqual(new Set(["JD-001"]));
  });

  test("rejects formula XML rather than executing it", () => {
    expect(formulaCellsInXml("<worksheet><c r=\"A1\"><f>1+1</f><v>2</v></c></worksheet>")).toBe(true);
    expect(formulaCellsInXml("<worksheet><c r=\"A1\"><v>2</v></c></worksheet>")).toBe(false);
  });

  test("builds versioned metadata", () => {
    expect(buildExportMetadata("one_time", "company-1", "Acme", "2026-01-01T00:00:00.000Z")).toMatchObject({ format: "cendro-task-export", version: 1, kind: "one_time" });
  });

  test("rejects invalid metadata from an unsupported workbook", () => {
    expect(() => parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "other-format"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "JD Tasks", data: [["Reference", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Status"]] },
    ], "company-1", "jd")).toThrow(/not a valid Cendro task workbook/);
  });

  test("exports and parses a Cendro workbook without task IDs", async () => {
    const workbook = await exportTaskWorkbook("one_time", "company-1", "Acme", [{ reference: "TSK-001", title: "=literal text", description: "Body", notes: "Important note", dueDate: Date.UTC(2026, 1, 1, 23, 59, 59), priority: "high", time: "30m", quantity: 2, assigneeEmails: "a@example.com", status: "Pending" }]);
    const sheets = await readXlsxFile(await workbook.toBlob());
    const parsed = parseCendroWorkbookSheets(sheets, "company-1", "one_time");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ reference: "TSK-001", title: "=literal text", description: "Body", notes: "Important note", priority: "high", quantity: 2, assigneeEmails: ["a@example.com"], status: "due" });
    expect(parsed.rows[0].dueDate).toBeTypeOf("number");
  });

  test("exports and parses a JD task workbook preserving notes", async () => {
    const workbook = await exportTaskWorkbook("jd", "company-1", "Acme", [{ reference: "JD-001", title: "Daily maintenance", description: "Inspect equipment", notes: "Check oil level", recurrence: "daily", time: "1h", quantity: 1, assigneeEmails: "admin@example.com", status: "Pending" }]);
    const sheets = await readXlsxFile(await workbook.toBlob());
    const parsed = parseCendroWorkbookSheets(sheets, "company-1", "jd");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ reference: "JD-001", title: "Daily maintenance", description: "Inspect equipment", notes: "Check oil level", recurrence: "daily", status: "due" });
  });

  test("handles sheets with trailing empty rows like Google Sheets exports", () => {
    const emptyRows = Array.from({ length: 998 }, () => [null, null, null, null, null, null, null, null, null]);
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"], ...emptyRows] },
      { sheet: "JD Tasks", data: [["Reference", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Status"], ["JD-0001", "Updated Title in Google Sheets", "", "", "daily", "", null, "admin@example.com", "Completed"], ...emptyRows] },
    ], "company-1", "jd");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].title).toBe("Updated Title in Google Sheets");
    expect(parsed.rows[0].reference).toBe("JD-0001");
    expect(parsed.rows[0].status).toBe("completed");
  });
});
