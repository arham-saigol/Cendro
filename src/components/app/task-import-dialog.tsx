"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Check, Download, FileSpreadsheet, LoaderCircle, Sparkles, Upload, X } from "lucide-react";
import { useConvex, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "./company-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  downloadBlob,
  exportTaskWorkbook,
  parseWorkbook,
  type ParsedWorkbook,
} from "@/lib/task-import/workbook";
import { candidateCellRows } from "@/lib/task-import/workbook";
import { AI_TASK_IMPORT_MAX_REQUEST_BYTES, AI_TASK_IMPORT_MAX_ROWS } from "@/lib/task-import/ai";
import type { TaskImportDraft, TaskImportField, TaskImportKind } from "@/lib/task-import/schema";

type PageKind = "jd" | "one";
type Stage = "choose" | "review" | "importing" | "complete";
type ReviewRow = {
  rowKey: string;
  sourceSheet: string;
  sourceRow: number;
  operation: "create" | "update" | "blocked";
  reference: string | null;
  draft: TaskImportDraft;
  current: any;
  proposedAssigneeMembershipIds: string[];
  unresolvedAssigneeHints: string[];
  errors: string[];
  warnings: string[];
  include: boolean;
};

const MAX_BATCH_ROWS = 25;
const recurrenceOptions = ["daily", "every_other_day", "weekly", "semimonthly", "monthly", "semiannually", "annually"] as const;
const priorityOptions = ["low", "medium", "high"] as const;

function dateInputValue(value: number | null) {
  if (value == null) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateFromInput(value: string) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 23, 59, 59, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function taskKind(kind: PageKind): TaskImportKind {
  return kind === "jd" ? "jd" : "one_time";
}

function operationLabel(operation: ReviewRow["operation"]) {
  return operation === "create" ? "Create" : operation === "update" ? "Update" : "Blocked";
}

function csvOrEmpty(values: string[]) { return values.join("; "); }

function warningsAfterEdit(warnings: string[], field: TaskImportField) {
  const fieldWarning = field === "quantity" ? /^Quantity must/
    : field === "dueDate" ? /due date|spreadsheet date/i
      : field === "recurrence" ? /^Frequency is not/
        : field === "priority" ? /^Priority is not/
          : field === "title" ? /^Formula-like text/
            : null;
  return fieldWarning ? warnings.filter((warning) => !fieldWarning.test(warning)) : warnings;
}

function currentTaskSummary(row: ReviewRow, kind: PageKind) {
  if (!row.current) return "";
  const values = [
    `Title: ${row.current.title}`,
    row.current.description ? `Description: ${String(row.current.description).slice(0, 80)}` : null,
    kind === "jd" ? `Frequency: ${row.current.recurrence}` : `Priority: ${row.current.priority}`,
    kind === "one" && row.current.dueDate ? `Due: ${dateInputValue(row.current.dueDate)}` : null,
    row.current.time ? `Time: ${row.current.time}` : null,
    row.current.quantity != null ? `Quantity: ${row.current.quantity}` : null,
  ];
  return values.filter(Boolean).join(" · ");
}

export function TaskImportDialog({ kind, open, onOpenChange }: { kind: PageKind; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { activeCompanyId } = useCompany();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("choose");
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedWorkbook | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [filter, setFilter] = useState<"all" | "create" | "update" | "warning" | "error">("all");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 0, created: 0, updated: 0, skipped: 0 });
  const [aiBusy, setAiBusy] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const [bulkAssigneeId, setBulkAssigneeId] = useState("");
  const [importKey, setImportKey] = useState(() => crypto.randomUUID());
  const [importing, setImporting] = useState(false);
  const [failedBatch, setFailedBatch] = useState<{ rows: ReviewRow[]; key: string } | null>(null);
  const [pendingBatches, setPendingBatches] = useState<{ rows: ReviewRow[]; key: string }[]>([]);
  const assignable = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: kind === "jd" ? "jd" : "one_time" } : "skip") as any[] | undefined;
  const convex = useConvex();
  const commit = useMutation(api.taskImports.commitTaskImportBatch);
  const contextKey = `${activeCompanyId ?? "none"}:${kind}`;
  const previousContextKey = useRef(contextKey);

  useEffect(() => {
    if (previousContextKey.current === contextKey) return;
    previousContextKey.current = contextKey;
    setStage("choose"); setFile(null); setParsed(null); setRows([]); setFilter("all"); setError(null); setProgress({ completed: 0, total: 0, created: 0, updated: 0, skipped: 0 }); setAiBusy(false); setCanCreate(false); setBulkAssigneeId(""); setImporting(false); setFailedBatch(null); setPendingBatches([]); setImportKey(crypto.randomUUID());
  }, [contextKey]);

  const visibleRows = useMemo(() => rows.filter((row) => filter === "all" || filter === "create" && row.operation === "create" || filter === "update" && row.operation === "update" || filter === "warning" && row.warnings.length > 0 || filter === "error" && row.errors.length > 0), [filter, rows]);
  const included = rows.filter((row) => row.include);
  const blocked = rows.filter((row) => row.operation === "blocked");
  const validIncluded = included.length > 0 && included.every((row) => row.errors.length === 0 && row.operation !== "blocked");

  function reset() {
    setStage("choose"); setFile(null); setParsed(null); setRows([]); setFilter("all"); setError(null); setProgress({ completed: 0, total: 0, created: 0, updated: 0, skipped: 0 }); setAiBusy(false); setCanCreate(false); setBulkAssigneeId(""); setImporting(false); setFailedBatch(null); setPendingBatches([]); setImportKey(crypto.randomUUID());
  }

  function close(nextOpen: boolean) {
    if (!nextOpen && importing) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  }

  function applyPreview(result: { rows: unknown[]; canCreate: boolean }, preserveSelection: boolean) {
    const nextRows = result.rows as ReviewRow[];
    setCanCreate(result.canCreate);
    setRows((current) => {
      if (!preserveSelection) return nextRows;
      const includedByKey = new Map(current.map((row) => [row.rowKey, row.include]));
      return nextRows.map((row) => ({ ...row, include: row.operation !== "blocked" && includedByKey.get(row.rowKey) === true }));
    });
  }

  async function chooseFile(nextFile: File) {
    if (!activeCompanyId) return;
    setError(null); setFile(nextFile);
    try {
      const next = await parseWorkbook(nextFile, activeCompanyId, taskKind(kind));
      setParsed(next);
      if (next.legacy) { setStage("review"); return; }
      const result = await convex.query(api.taskImports.previewTaskImport, { companyId: activeCompanyId, kind: taskKind(kind), drafts: next.rows as any });
      applyPreview(result, false);
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse this workbook.");
      setParsed(null); setRows([]);
    }
  }

  async function analyzeWithAi() {
    if (!parsed || !activeCompanyId || aiBusy) return;
    setAiBusy(true); setError(null);
    try {
      const cellRows = candidateCellRows(parsed.sheetData);
      if (cellRows.length > AI_TASK_IMPORT_MAX_ROWS) throw new Error(`AI analysis supports at most ${AI_TASK_IMPORT_MAX_ROWS} non-empty source rows. Remove unrelated sheets or split the workbook.`);
      const requestBytes = new TextEncoder().encode(JSON.stringify({ kind: taskKind(kind), rows: cellRows })).byteLength;
      if (requestBytes > AI_TASK_IMPORT_MAX_REQUEST_BYTES) throw new Error("The workbook content is too large for one AI import. Remove unrelated sheets or split the workbook.");
      const response = await fetch("/api/ai/task-import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId: activeCompanyId, kind: taskKind(kind), payload: { kind: taskKind(kind), rows: cellRows } }) });
      const body = await response.json() as { rows?: TaskImportDraft[]; error?: string };
      if (!response.ok || !body.rows) throw new Error(body.error ?? "AI analysis failed.");
      const result = await convex.query(api.taskImports.previewTaskImport, { companyId: activeCompanyId, kind: taskKind(kind), drafts: body.rows as any });
      applyPreview(result, false); setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI analysis failed.");
    } finally { setAiBusy(false); }
  }

  function toggleRow(rowKey: string, checked: boolean) {
    if (failedBatch) return;
    setRows((current) => current.map((row) => row.rowKey === rowKey && row.operation !== "blocked" ? { ...row, include: checked } : row));
  }

  function invalidateFailedBatch() {
    setFailedBatch(null); setPendingBatches([]); setError(null);
  }

  function patchRow(rowKey: string, field: TaskImportField, patch: Partial<TaskImportDraft>) {
    if (failedBatch) return;
    invalidateFailedBatch();
    setRows((current) => current.map((row) => {
      if (row.rowKey !== rowKey) return row;
      const presentFields = (row.draft.presentFields.includes(field) ? row.draft.presentFields : [...row.draft.presentFields, field]) as TaskImportDraft["presentFields"];
      return { ...row, draft: { ...row.draft, ...patch, presentFields, warnings: warningsAfterEdit(row.draft.warnings, field) }, errors: ["Edited row needs revalidation before import."] };
    }));
  }

  function markAiRowReviewed(rowKey: string) {
    if (failedBatch) return;
    invalidateFailedBatch();
    setRows((current) => current.map((row) => row.rowKey === rowKey ? { ...row, draft: { ...row.draft, confidence: null }, errors: ["Reviewed row needs revalidation before import."] } : row));
  }

  function convertUnknownToCreate(rowKey: string) {
    if (failedBatch) return;
    invalidateFailedBatch();
    setRows((current) => current.map((row) => row.rowKey === rowKey ? { ...row, reference: null, draft: { ...row.draft, reference: null, presentFields: row.draft.presentFields.filter((field) => field !== "reference") }, operation: "create", errors: ["Edited row needs revalidation before import."], include: false } : row));
  }

  function assigneeValues(membershipIds: string[]) {
    const people = membershipIds.map((membershipId) => (assignable ?? []).find((candidate: any) => candidate.membership._id === membershipId)).filter(Boolean);
    return { membershipIds: people.map((person: any) => person.membership._id as string), emails: people.map((person: any) => person.user.email as string) };
  }

  function changeAssignees(rowKey: string, membershipIds: string[]) {
    if (failedBatch) return;
    const selected = assigneeValues(membershipIds);
    invalidateFailedBatch();
    setRows((current) => current.map((row) => {
      if (row.rowKey !== rowKey) return row;
      const presentFields = (row.draft.presentFields.includes("assignees") ? row.draft.presentFields : [...row.draft.presentFields, "assignees"]) as TaskImportDraft["presentFields"];
      return { ...row, draft: { ...row.draft, rawAssigneeText: selected.emails.join("; "), assigneeEmails: selected.emails, presentFields }, proposedAssigneeMembershipIds: selected.membershipIds, unresolvedAssigneeHints: [], errors: ["Edited row needs revalidation before import."] };
    }));
  }

  function applyBulkAssignee() {
    if (failedBatch) return;
    const selected = assigneeValues([bulkAssigneeId]);
    if (selected.membershipIds.length === 0) return;
    invalidateFailedBatch();
    setRows((current) => current.map((row) => {
      if (!row.include || row.operation === "blocked") return row;
      const presentFields = (row.draft.presentFields.includes("assignees") ? row.draft.presentFields : [...row.draft.presentFields, "assignees"]) as TaskImportDraft["presentFields"];
      return { ...row, draft: { ...row.draft, rawAssigneeText: selected.emails[0], assigneeEmails: selected.emails, presentFields }, proposedAssigneeMembershipIds: selected.membershipIds, unresolvedAssigneeHints: [], errors: ["Edited row needs revalidation before import."] };
    }));
  }

  async function revalidate() {
    if (!activeCompanyId || failedBatch) return;
    setError(null);
    try {
      const result = await convex.query(api.taskImports.previewTaskImport, { companyId: activeCompanyId, kind: taskKind(kind), drafts: rows.map((row) => row.draft) as any });
      applyPreview(result, true);
      setFailedBatch(null); setPendingBatches([]);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not revalidate rows."); }
  }

  async function processBatches(entries: { rows: ReviewRow[]; key: string }[], startingProgress: typeof progress) {
    if (!activeCompanyId) return;
    setImporting(true); setStage("importing"); setError(null);
    let nextProgress = startingProgress;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      setFailedBatch(entry);
      try {
        const result = await commit({ companyId: activeCompanyId, kind: taskKind(kind), importKey, batchKey: entry.key, source: entry.rows[0].draft.source, rows: entry.rows.map((row) => ({ draft: row.draft as any, include: true, expectedUpdatedAt: row.current?.updatedAt, selectedAssigneeMembershipIds: row.draft.assigneeEmails.length || row.draft.rawAssigneeText.trim() ? row.proposedAssigneeMembershipIds as Id<"companyMemberships">[] : null })) });
        nextProgress = { completed: nextProgress.completed + entry.rows.length, total: nextProgress.total, created: nextProgress.created + result.created, updated: nextProgress.updated + result.updated, skipped: nextProgress.skipped };
        setProgress(nextProgress);
        setFailedBatch(null);
      } catch (err) {
        const remaining = entries.slice(index);
        const serverRejected = err instanceof ConvexError;
        setPendingBatches(serverRejected ? [] : remaining);
        setFailedBatch(serverRejected ? null : entry);
        setRows(remaining.flatMap((batch) => batch.rows).map((row) => serverRejected ? { ...row, errors: ["Batch validation failed. Revalidate before importing."], include: row.include } : row));
        setError(err instanceof Error ? err.message : "A batch failed. Retry the same batch key or revalidate.");
        setStage("review"); setImporting(false);
        return;
      }
    }
    setPendingBatches([]); setFailedBatch(null); setImporting(false); setStage("complete");
  }

  function startImport() {
    if (!activeCompanyId || !validIncluded || importing || failedBatch) return;
    const batches: { rows: ReviewRow[]; key: string }[] = [];
    for (let i = 0; i < included.length; i += MAX_BATCH_ROWS) batches.push({ rows: included.slice(i, i + MAX_BATCH_ROWS), key: crypto.randomUUID() });
    const startingProgress = progress.total > 0
      ? { ...progress, total: progress.completed + included.length, skipped: progress.skipped + rows.length - included.length }
      : { completed: 0, total: included.length, created: 0, updated: 0, skipped: rows.length - included.length };
    setProgress(startingProgress);
    setPendingBatches(batches);
    void processBatches(batches, startingProgress);
  }

  function retryFailedBatch() {
    if (!failedBatch || importing) return;
    void processBatches(pendingBatches.length > 0 ? pendingBatches : [failedBatch], progress);
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-elevated)] md:inset-8">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--hairline)] px-5 py-4">
            <div className="flex items-center gap-3"><FileSpreadsheet className="h-5 w-5 text-[var(--primary)]" /><div><Dialog.Title className="text-[15px] font-semibold">Import {kind === "jd" ? "JD" : "one-time"} tasks</Dialog.Title><Dialog.Description className="mt-0.5 text-[12px] text-[var(--ink-muted)]">Review everything before Cendro writes anything.</Dialog.Description></div></div>
            <Dialog.Close asChild><button type="button" className="task-icon-btn" aria-label="Close task import"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-5 py-2 text-[12px] text-[var(--ink-muted)]"><span className={cn(stage === "choose" && "font-semibold text-[var(--ink)]")}>1. Choose file</span><span>→</span><span className={cn(stage === "review" && "font-semibold text-[var(--ink)]")}>2. Review</span><span>→</span><span className={cn(stage === "importing" && "font-semibold text-[var(--ink)]")}>3. Import</span><span>→</span><span className={cn(stage === "complete" && "font-semibold text-[var(--ink)]")}>4. Complete</span></div>
            <div className="min-h-0 flex-1 overflow-auto p-5">
              {stage === "choose" && <div className="mx-auto flex max-w-xl flex-col items-center justify-center py-16 text-center"><Upload className="h-8 w-8 text-[var(--primary)]" /><h2 className="mt-4 text-lg font-semibold">Choose a Cendro workbook</h2><p className="mt-2 text-sm text-[var(--ink-muted)]">Import only .xlsx files, up to 10 MB and 500 task rows. .xls and .xlsm files must be saved as .xlsx first.</p><Button className="mt-5" variant="primary" onClick={() => inputRef.current?.click()}><Upload className="h-4 w-4" />Choose .xlsx file</Button><input ref={inputRef} className="sr-only" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const next = event.target.files?.[0]; if (next) void chooseFile(next); event.currentTarget.value = ""; }} /><p className="mt-4 text-[12px] text-[var(--ink-muted)]">Use Export beside New task to create a Cendro workbook.</p></div>}
              {stage === "review" && parsed?.legacy && rows.length === 0 && <div className="mx-auto max-w-xl py-14 text-center"><AlertTriangle className="mx-auto h-8 w-8 text-[var(--badge-yellow-fg)]" /><h2 className="mt-4 text-lg font-semibold">Legacy workbook detected</h2><p className="mt-2 text-sm text-[var(--ink-muted)]">This file does not contain valid Cendro metadata and headers. You can review its bounded cell content with DeepSeek, or choose a Cendro export.</p><p className="mt-3 text-xs text-[var(--ink-faint)]">The workbook data will be sent to DeepSeek only after you choose Analyze with AI. AI extracts drafts only; it never selects users or writes tasks.</p><Button className="mt-5" variant="primary" disabled={aiBusy} onClick={() => void analyzeWithAi()}>{aiBusy ? <><LoaderCircle className="h-4 w-4 animate-spin" />Analyzing...</> : <><Sparkles className="h-4 w-4" />Analyze with AI</>}</Button></div>}
              {stage === "review" && rows.length > 0 && <div><div className="mb-4 flex flex-wrap items-center gap-2"><div className="text-sm font-medium">{rows.filter((row) => row.operation === "create").length} creates · {rows.filter((row) => row.operation === "update").length} updates · {rows.filter((row) => !row.include).length} skipped · {blocked.length} blocked</div><div className="ml-auto flex items-center gap-1"><select className="h-8 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-[12px]" value={bulkAssigneeId} onChange={(event) => setBulkAssigneeId(event.target.value)}><option value="">Bulk assignee</option>{(assignable ?? []).map((person: any) => <option key={person.membership._id} value={person.membership._id}>{person.user.name || person.user.email}</option>)}</select><Button size="sm" variant="secondary" disabled={!bulkAssigneeId || included.length === 0} onClick={applyBulkAssignee}>Apply to selected</Button></div><div className="flex flex-wrap gap-1">{(["all", "create", "update", "warning", "error"] as const).map((option) => <button key={option} type="button" className={cn("rounded-md px-2 py-1 text-[12px]", filter === option ? "bg-[var(--surface-pressed)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--surface-muted)]")} onClick={() => setFilter(option)}>{option[0].toUpperCase() + option.slice(1)}</button>)}</div></div><div className="overflow-x-auto rounded-lg border border-[var(--hairline)]"><table className="min-w-[1040px] w-full text-left text-[12px]"><thead className="bg-[var(--surface-muted)] text-[var(--ink-muted)]"><tr><th className="w-10 px-3 py-2"> </th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Operation</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Task fields</th><th className="px-3 py-2">Assignees</th><th className="px-3 py-2">Warnings / errors</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.rowKey} className="border-t border-[var(--hairline)] align-top"><td className="px-3 py-3">{row.operation !== "blocked" && <Checkbox checked={row.include} onCheckedChange={(checked) => toggleRow(row.rowKey, checked === true)} aria-label={`Include row ${row.sourceRow}`} />}</td><td className="whitespace-nowrap px-3 py-3 text-[var(--ink-muted)]">{row.sourceSheet}:{row.sourceRow}</td><td className="px-3 py-3"><span className={cn("rounded px-1.5 py-1 text-[11px]", row.operation === "create" ? "bg-[var(--badge-blue-bg)] text-[var(--badge-blue-fg)]" : row.operation === "update" ? "bg-[var(--badge-green-bg)] text-[var(--badge-green-fg)]" : "bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]")}>{operationLabel(row.operation)}</span>{canCreate && row.operation === "blocked" && row.errors.some((message) => message.includes("unavailable or not updatable")) && <button type="button" className="mt-2 block text-[11px] underline" onClick={() => convertUnknownToCreate(row.rowKey)}>Create as new</button>}</td><td className="px-3 py-3 font-mono">{row.reference ?? "(new)"}</td><td className="min-w-[340px] px-3 py-3"><div className="grid gap-1.5"><Input className="h-8 text-[12px]" value={row.draft.title ?? ""} onChange={(event) => patchRow(row.rowKey, "title", { title: event.target.value })} placeholder="Title" /><Input className="h-8 text-[12px]" value={row.draft.description ?? ""} onChange={(event) => patchRow(row.rowKey, "description", { description: event.target.value })} placeholder="Description" />{row.operation === "update" && <div className="text-[11px] text-[var(--ink-muted)]">Current — {currentTaskSummary(row, kind)}</div>}<div className="flex gap-1.5"><Input className="h-8 text-[12px]" value={row.draft.time ?? ""} onChange={(event) => patchRow(row.rowKey, "time", { time: event.target.value })} placeholder="Time" /><Input className="h-8 text-[12px]" value={row.draft.quantity == null ? "" : String(row.draft.quantity)} onChange={(event) => patchRow(row.rowKey, "quantity", { quantity: event.target.value ? Number(event.target.value) : null })} placeholder="Qty" type="number" />{kind === "jd" ? <select className="h-8 min-w-0 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-[12px]" value={row.draft.recurrence ?? ""} onChange={(event) => patchRow(row.rowKey, "recurrence", { recurrence: (event.target.value || null) as any })}><option value="">Frequency</option>{recurrenceOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <select className="h-8 min-w-0 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-[12px]" value={row.draft.priority ?? ""} onChange={(event) => patchRow(row.rowKey, "priority", { priority: (event.target.value || null) as any })}><option value="">Priority</option>{priorityOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select>}{kind === "one" && <Input className="h-8 text-[12px]" type="date" value={dateInputValue(row.draft.dueDate)} onChange={(event) => patchRow(row.rowKey, "dueDate", { dueDate: dateFromInput(event.target.value) })} />}</div></div></td><td className="min-w-[190px] px-3 py-3"><select multiple size={3} className="w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 py-1 text-[12px]" value={row.proposedAssigneeMembershipIds} onChange={(event) => changeAssignees(row.rowKey, Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>{(assignable ?? []).map((person: any) => <option key={person.membership._id} value={person.membership._id}>{person.user.name || person.user.email} · {person.user.email}</option>)}</select>{row.unresolvedAssigneeHints.length > 0 && <div className="mt-1 text-[11px] text-[var(--badge-yellow-fg)]">{csvOrEmpty(row.unresolvedAssigneeHints)}</div>}</td><td className="max-w-[300px] px-3 py-3">{row.errors.map((message) => <div key={message} className="text-[var(--danger)]">{message}</div>)}{row.warnings.map((message) => <div key={message} className="text-[var(--badge-yellow-fg)]">{message}</div>)}{row.draft.source === "ai" && row.draft.confidence === "low" && <button type="button" className="mt-2 text-[11px] underline" onClick={() => markAiRowReviewed(row.rowKey)}>Mark row reviewed</button>}</td></tr>)}</tbody></table></div><div className="mt-3 flex items-center justify-between"><span className="text-[12px] text-[var(--ink-muted)]">{file?.name} · {rows.length} rows · {included.length} included</span><Button variant="secondary" disabled={Boolean(failedBatch)} onClick={() => void revalidate()}>Revalidate</Button></div></div>}
              {stage === "importing" && <div className="mx-auto max-w-md py-20 text-center"><LoaderCircle className="mx-auto h-8 w-8 animate-spin text-[var(--primary)]" /><h2 className="mt-4 text-lg font-semibold">Importing tasks</h2><p className="mt-2 text-sm text-[var(--ink-muted)]">{progress.completed} of {progress.total} rows committed. Safe to retry a lost network request.</p></div>}
              {stage === "complete" && <div className="mx-auto max-w-md py-20 text-center"><span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-[var(--badge-green-bg)] text-[var(--badge-green-fg)]"><Check className="h-5 w-5" /></span><h2 className="mt-4 text-lg font-semibold">Import complete</h2><p className="mt-2 text-sm text-[var(--ink-muted)]">{progress.created} created · {progress.updated} updated · {progress.skipped} skipped</p></div>}
              {error && <div className="alert-error mt-4 flex items-center justify-between gap-3 rounded-md px-3 py-2 text-[13px]" role="alert"><span>{error}</span>{failedBatch && <Button variant="ghost" size="sm" onClick={retryFailedBatch}>Retry failed batch</Button>}</div>}
            </div>
            <div className="flex shrink-0 items-center justify-between border-t border-[var(--hairline)] px-5 py-4"><span className="text-[12px] text-[var(--ink-muted)]">{stage === "review" && `${included.length} selected · ${blocked.length} blocked`}</span><div className="flex gap-2"><Button variant="secondary" onClick={() => close(false)}>{stage === "complete" ? "Close" : "Cancel"}</Button>{stage === "review" && rows.length > 0 && <Button variant="primary" disabled={!validIncluded || importing || Boolean(failedBatch)} onClick={() => void startImport()}>Confirm import</Button>}</div></div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TaskExportButton({ kind }: { kind: PageKind }) {
  const { activeCompanyId, active } = useCompany();
  const pages = usePaginatedQuery(api.tasks.exportRows, activeCompanyId ? { companyId: activeCompanyId, kind: taskKind(kind) } : "skip", { initialNumItems: 200 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = pages.status === "LoadingFirstPage" || pages.status === "LoadingMore";
  useEffect(() => {
    if (pages.status === "CanLoadMore" && !busy) pages.loadMore(200);
  }, [busy, pages]);
  async function exportNow() {
    if (!activeCompanyId || !active || busy || loading || pages.status !== "Exhausted") return;
    setBusy(true); setError(null);
    try { const workbook = await exportTaskWorkbook(taskKind(kind), activeCompanyId, active.company.name, pages.results as any); downloadBlob(await workbook.toBlob(), `${kind === "jd" ? "jd-tasks" : "one-time-tasks"}.xlsx`); } catch (err) { setError(err instanceof Error ? err.message : "Could not export tasks."); } finally { setBusy(false); }
  }
  return <>{error && <span className="text-[12px] text-[var(--danger)]">{error}</span>}<Button variant="secondary" size="sm" disabled={!activeCompanyId || loading || pages.status !== "Exhausted" || busy} onClick={() => void exportNow()}><Download className="h-4 w-4" />{loading ? "Loading..." : busy ? "Exporting..." : "Export"}</Button></>;
}
