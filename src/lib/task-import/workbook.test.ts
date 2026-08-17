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
  referenceForKind,
} from "./workbook";

describe("task workbook pure helpers", () => {
  test("normalizes canonical enum aliases and statuses", () => {
    expect(normalizeFrequency("Every other day")).toBe("every_other_day");
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
    expect(new Date(parseStrictDate("2026-02-01").value!).toISOString()).toContain("2026-02-01");
    expect(parseStrictDate("2026-02-01 25:00").error).toBe("Invalid due date.");
  });

  test("normalizes semicolon separated emails without fuzzy names", () => {
    expect(parseAssigneeEmails(" A@Example.com; b@example.com; ")).toEqual({ raw: "A@Example.com; b@example.com;", emails: ["a@example.com", "b@example.com"] });
  });

  test("protects formula-leading text and validates references", () => {
    expect(protectFormulaText("=1+1")).toBe("'=1+1");
    expect(referenceForKind("JD-0001", "jd")).toEqual({ value: "JD-0001" });
    expect(referenceForKind("JD-10000", "jd")).toEqual({ value: "JD-10000" });
    expect(referenceForKind("OT-0001", "jd").error).toBeTruthy();
  });

  test("finds duplicate workbook references", () => {
    expect(duplicateReferences([{ reference: "JD-0001" }, { reference: "jd-0001" }, { reference: null }])).toEqual(new Set(["JD-0001"]));
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
      { sheet: "JD Tasks", data: [["Reference", "Title", "Description", "Frequency", "Time", "Quantity", "Assignee Emails", "Status"]] },
    ], "company-1", "jd")).toThrow(/not a valid Cendro task workbook/);
  });

  test("exports and parses a Cendro workbook without task IDs", async () => {
    const workbook = await exportTaskWorkbook("one_time", "company-1", "Acme", [{ reference: "OT-0001", title: "=literal text", description: "Body", dueDate: Date.UTC(2026, 1, 1, 23, 59, 59), priority: "high", time: "30m", quantity: 2, assigneeEmails: "a@example.com", status: "Pending" }]);
    const sheets = await readXlsxFile(await workbook.toBlob());
    const parsed = parseCendroWorkbookSheets(sheets, "company-1", "one_time");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ reference: "OT-0001", title: "=literal text", priority: "high", quantity: 2, assigneeEmails: ["a@example.com"], status: "due" });
    expect(parsed.rows[0].dueDate).toBeTypeOf("number");
  });

  test("handles sheets with trailing empty rows like Google Sheets exports", () => {
    const emptyRows = Array.from({ length: 998 }, () => [null, null, null, null, null, null, null, null]);
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"], ...emptyRows] },
      { sheet: "JD Tasks", data: [["Reference", "Title", "Description", "Frequency", "Time", "Quantity", "Assignee Emails", "Status"], ["JD-0001", "Updated Title in Google Sheets", "", "daily", "", null, "admin@example.com", "Completed"], ...emptyRows] },
    ], "company-1", "jd");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].title).toBe("Updated Title in Google Sheets");
    expect(parsed.rows[0].reference).toBe("JD-0001");
    expect(parsed.rows[0].status).toBe("completed");
  });
});
