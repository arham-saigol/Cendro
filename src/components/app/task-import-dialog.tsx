"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, CheckCircle2, Download, LoaderCircle, Upload, X } from "lucide-react";
import { useConvex, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "./company-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  downloadBlob,
  exportTaskWorkbook,
  parseWorkbook,
} from "@/lib/task-import/workbook";
import type { TaskImportDraft, TaskImportKind } from "@/lib/task-import/schema";

type PageKind = "jd" | "one";
type ReviewRow = {
  rowKey: string;
  sourceSheet: string;
  sourceRow: number;
  operation: "create" | "update" | "blocked";
  reference: string | null;
  draft: TaskImportDraft;
  current: { updatedAt?: number } | null;
  proposedAssigneeMembershipIds: string[];
  unresolvedAssigneeHints: string[];
  errors: string[];
  warnings: string[];
  include: boolean;
};

const MAX_BATCH_ROWS = 25;
const recurrenceOptions = ["daily", "every_other_day", "weekly", "semimonthly", "monthly", "semiannually", "annually"] as const;
const priorityOptions = ["low", "medium", "high"] as const;

function taskKind(kind: PageKind): TaskImportKind {
  return kind === "jd" ? "jd" : "one_time";
}

export function TaskImportButton({
  kind,
  onNotification,
}: {
  kind: PageKind;
  onNotification?: (notification: { type: "success" | "error"; message: string }) => void;
}) {
  const { activeCompanyId } = useCompany();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const convex = useConvex();
  const commit = useMutation(api.taskImports.commitTaskImportBatch);

  const [busy, setBusy] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [importKey, setImportKey] = useState(() => crypto.randomUUID());

  const assignable = useQuery(
    api.tasks.assignableUsers,
    activeCompanyId ? { companyId: activeCompanyId, kind: taskKind(kind) } : "skip"
  );

  async function handleFile(file: File) {
    if (!activeCompanyId) return;
    setBusy(true);
    setFileName(file.name);
    const currentImportKey = crypto.randomUUID();
    setImportKey(currentImportKey);
    try {
      const parsed = await parseWorkbook(file, activeCompanyId, taskKind(kind));
      if (parsed.rows.length === 0) {
        throw new Error("No task rows found in this workbook.");
      }

      const preview = await convex.query(api.taskImports.previewTaskImport, {
        companyId: activeCompanyId,
        kind: taskKind(kind),
        drafts: parsed.rows,
      });

      const nextRows = preview.rows as ReviewRow[];
      const blocked = nextRows.filter((r) => r.operation === "blocked" || r.errors.length > 0);

      if (blocked.length === 0) {
        // Direct seamless import!
        await executeImport(nextRows, currentImportKey);
      } else {
        // Problematic rows found — open issues dialog
        setRows(nextRows);
        setIssuesOpen(true);
      }
    } catch (err) {
      onNotification?.({
        type: "error",
        message: err instanceof Error ? err.message : "Could not import workbook.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function executeImport(rowsToImport: ReviewRow[], keyOverride?: string) {
    if (!activeCompanyId) return;
    setBusy(true);
    const keyToUse = keyOverride ?? importKey;
    const included = rowsToImport.filter((r) => r.include && r.operation !== "blocked" && r.errors.length === 0);
    if (included.length === 0) {
      onNotification?.({ type: "error", message: "No valid tasks to import." });
      setBusy(false);
      return;
    }

    try {
      let created = 0;
      let updated = 0;
      for (let i = 0; i < included.length; i += MAX_BATCH_ROWS) {
        const batch = included.slice(i, i + MAX_BATCH_ROWS);
        const batchIndex = Math.floor(i / MAX_BATCH_ROWS);
        try {
          const result = await commit({
            companyId: activeCompanyId,
            kind: taskKind(kind),
            importKey: keyToUse,
            batchKey: `${keyToUse}:${batchIndex}`,
            source: "cendro",
            rows: batch.map((row) => ({
              draft: row.draft,
              include: true,
              expectedUpdatedAt: row.current?.updatedAt,
              selectedAssigneeMembershipIds:
                row.draft.assigneeEmails.length || row.draft.rawAssigneeText.trim()
                  ? (row.proposedAssigneeMembershipIds as Id<"companyMemberships">[])
                  : null,
            })),
          });
          created += result.created;
          updated += result.updated;
        } catch (err) {
          onNotification?.({
            type: "error",
            message: `Imported ${created} created and ${updated} updated before the import stopped. ${err instanceof Error ? err.message : ""}`.trim(),
          });
          return;
        }
      }

      setIssuesOpen(false);
      onNotification?.({
        type: "success",
        message: `Successfully imported ${included.length} task${included.length === 1 ? "" : "s"} (${created} created, ${updated} updated).`,
      });
    } catch (err) {
      onNotification?.({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to import tasks.",
      });
    } finally {
      setBusy(false);
    }
  }

  function changeAssignees(rowKey: string, membershipIds: string[]) {
    const people = membershipIds
      .map((id) => (assignable ?? []).find((c) => c.membership._id === id))
      .filter(Boolean);
    const emails = people.map((p) => p!.user.email);
    setRows((current) =>
      current.map((row) => {
        if (row.rowKey !== rowKey) return row;
        return {
          ...row,
          draft: { ...row.draft, rawAssigneeText: emails.join("; "), assigneeEmails: emails },
          proposedAssigneeMembershipIds: membershipIds,
          unresolvedAssigneeHints: [],
        };
      })
    );
  }

  function patchRow(rowKey: string, patch: Partial<TaskImportDraft>) {
    setRows((current) =>
      current.map((row) => (row.rowKey === rowKey ? { ...row, draft: { ...row.draft, ...patch } } : row))
    );
  }

  async function revalidateAndImport() {
    if (!activeCompanyId) return;
    setBusy(true);
    try {
      const preview = await convex.query(api.taskImports.previewTaskImport, {
        companyId: activeCompanyId,
        kind: taskKind(kind),
        drafts: rows.map((r) => r.draft),
      });
      const nextRows = preview.rows as ReviewRow[];
      setRows(nextRows);
      const blocked = nextRows.filter((r) => r.operation === "blocked" || r.errors.length > 0);
      if (blocked.length === 0) {
        await executeImport(nextRows);
      }
    } catch (err) {
      onNotification?.({
        type: "error",
        message: err instanceof Error ? err.message : "Validation failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  const validCount = rows.filter((r) => r.operation !== "blocked" && r.errors.length === 0).length;
  const issueRows = rows.filter((r) => r.operation === "blocked" || r.errors.length > 0 || r.warnings.length > 0);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || !activeCompanyId}
        onClick={() => fileInputRef.current?.click()}
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {busy ? "Importing..." : "Import"}
      </Button>

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.currentTarget.value = "";
        }}
      />

      <Dialog.Root open={issuesOpen} onOpenChange={(open) => !busy && setIssuesOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
          <Dialog.Content className="fixed inset-3 z-50 flex max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-elevated)] md:inset-y-12 md:left-1/2 md:w-full md:-translate-x-1/2">
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--hairline)] px-5 py-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-[var(--badge-yellow-fg)]" />
                <div>
                  <Dialog.Title className="text-[15px] font-semibold">Import Issues Found</Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                    {fileName} — {issueRows.length} of {rows.length} rows need attention
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="task-icon-btn" aria-label="Close dialog">
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
              {validCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-muted)] p-3 text-[13px] text-[var(--ink-muted)]">
                  <CheckCircle2 className="h-4 w-4 text-[var(--badge-green-fg)]" />
                  <span>
                    <strong>{validCount}</strong> of {rows.length} tasks are valid and ready to import.
                  </span>
                </div>
              )}

              <div className="space-y-3">
                {issueRows.map((row) => (
                  <div
                    key={row.rowKey}
                    className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12px] font-semibold text-[var(--ink)]">
                            {row.reference ?? "New Task"}
                          </span>
                          <span className="text-[11px] text-[var(--ink-muted)]">
                            Row {row.sourceRow}
                          </span>
                        </div>
                        <p className="mt-1 text-[13px] font-medium text-[var(--ink)]">
                          {row.draft.title || "(Untitled task)"}
                        </p>
                      </div>

                      <span
                        className={cn(
                          "rounded px-2 py-0.5 text-[11px] font-medium",
                          row.operation === "blocked"
                            ? "bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]"
                            : "bg-[var(--badge-yellow-bg)] text-[var(--badge-yellow-fg)]"
                        )}
                      >
                        {row.operation === "blocked" ? "Blocked" : "Warning"}
                      </span>
                    </div>

                    {row.errors.length > 0 && (
                      <div className="mt-2 space-y-1 text-[12px] text-[var(--danger)]">
                        {row.errors.map((msg, i) => (
                          <div key={i}>• {msg}</div>
                        ))}
                      </div>
                    )}

                    {row.warnings.length > 0 && (
                      <div className="mt-2 space-y-1 text-[12px] text-[var(--badge-yellow-fg)]">
                        {row.warnings.map((msg, i) => (
                          <div key={i}>• {msg}</div>
                        ))}
                      </div>
                    )}

                    {/* Inline resolution tools */}
                    <div className="mt-3 grid gap-2 border-t border-[var(--hairline)] pt-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor={`assignee-${row.rowKey}`} className="mb-1 block text-[11px] font-medium text-[var(--ink-muted)]">
                          Assignee
                        </label>
                        <select
                          id={`assignee-${row.rowKey}`}
                          className="h-8 w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-[12px]"
                          value={row.proposedAssigneeMembershipIds[0] ?? ""}
                          onChange={(e) => changeAssignees(row.rowKey, e.target.value ? [e.target.value] : [])}
                        >
                          <option value="">Select an active member</option>
                          {(assignable ?? []).map((person) => (
                            <option key={person.membership._id} value={person.membership._id}>
                              {person.user.name || person.user.email} ({person.user.email})
                            </option>
                          ))}
                        </select>
                      </div>

                      {kind === "jd" ? (
                        <div>
                          <label htmlFor={`frequency-${row.rowKey}`} className="mb-1 block text-[11px] font-medium text-[var(--ink-muted)]">
                            Frequency
                          </label>
                          <select
                            id={`frequency-${row.rowKey}`}
                            className="h-8 w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-[12px]"
                            value={row.draft.recurrence ?? ""}
                            onChange={(e) =>
                              patchRow(row.rowKey, { recurrence: (e.target.value || null) as TaskImportDraft["recurrence"] })
                            }
                          >
                            <option value="">Select frequency</option>
                            {recurrenceOptions.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div>
                          <label htmlFor={`priority-${row.rowKey}`} className="mb-1 block text-[11px] font-medium text-[var(--ink-muted)]">
                            Priority
                          </label>
                          <select
                            id={`priority-${row.rowKey}`}
                            className="h-8 w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-[12px]"
                            value={row.draft.priority ?? ""}
                            onChange={(e) =>
                              patchRow(row.rowKey, { priority: (e.target.value || null) as TaskImportDraft["priority"] })
                            }
                          >
                            <option value="">Select priority</option>
                            {priorityOptions.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-[var(--hairline)] px-5 py-4">
              <Button variant="secondary" size="sm" onClick={() => setIssuesOpen(false)}>
                Cancel
              </Button>
              <div className="flex gap-2">
                {validCount > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => executeImport(rows.filter((r) => r.operation !== "blocked" && r.errors.length === 0))}
                  >
                    Import only {validCount} valid tasks
                  </Button>
                )}
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void revalidateAndImport()}>
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  Revalidate & Import
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export function TaskExportButton({ kind }: { kind: PageKind }) {
  const { activeCompanyId, active } = useCompany();
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pages = usePaginatedQuery(
    api.tasks.exportRows,
    activeCompanyId && requested ? { companyId: activeCompanyId, kind: taskKind(kind) } : "skip",
    { initialNumItems: 200 }
  );

  const loading = requested && (pages.status === "LoadingFirstPage" || pages.status === "LoadingMore");

  useEffect(() => {
    if (requested && pages.status === "CanLoadMore" && !busy) {
      pages.loadMore(200);
    }
  }, [busy, pages, requested]);

  useEffect(() => {
    if (requested && pages.status === "Exhausted" && !busy && activeCompanyId && active) {
      setBusy(true);
      setError(null);
      let cancelled = false;
      const capturedActiveCompanyId = activeCompanyId;
      const capturedKind = kind;
      void (async () => {
        try {
          const workbook = await exportTaskWorkbook(taskKind(capturedKind), capturedActiveCompanyId, active.company.name, pages.results);
          if (cancelled) return;
          downloadBlob(await workbook.toBlob(), `${capturedKind === "jd" ? "jd-tasks" : "one-time-tasks"}.xlsx`);
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Could not export tasks.");
        } finally {
          if (cancelled) return;
          setBusy(false);
          setRequested(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [active, activeCompanyId, busy, kind, pages.results, pages.status, requested]);

  return (
    <>
      {error && <span className="text-[12px] text-[var(--danger)]">{error}</span>}
      <Button
        variant="secondary"
        size="sm"
        disabled={!activeCompanyId || loading || busy}
        onClick={() => {
          setError(null);
          setRequested(true);
        }}
      >
        <Download className="h-4 w-4" />
        {loading ? "Loading..." : busy ? "Exporting..." : "Export"}
      </Button>
    </>
  );
}
