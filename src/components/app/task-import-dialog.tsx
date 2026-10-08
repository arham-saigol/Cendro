"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  AlertCircle,
  ArrowUpDown,
  ChevronDown,
  Download,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import { useConvex, useMutation } from "convex/react";
import { useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "./company-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskImportDraft, TaskImportKind } from "@/lib/task-import/schema";

// The workbook stack (xlsx readers/writers) is heavy — load it on demand.
const loadWorkbook = () => import("@/lib/task-import/workbook");

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

function taskKind(kind: PageKind): TaskImportKind {
  return kind === "jd" ? "jd" : "one_time";
}

function rowBlocksImport(row: ReviewRow) {
  return row.operation === "blocked" || row.errors.length > 0;
}

export function TaskImportExportMenu({
  kind,
  onNotification,
}: {
  kind: PageKind;
  onNotification?: (notification: { type: "success" | "error"; message: string }) => void;
}) {
  const { activeCompanyId, active } = useCompany();
  const kindPrefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  const canImport = active?.capabilities.includes(`${kindPrefix}:import`) ?? false;
  const canExport = active?.capabilities.includes(`${kindPrefix}:export`) ?? false;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const convex = useConvex();
  const commit = useMutation(api.taskImports.commitTaskImportBatch);

  const [importBusy, setImportBusy] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);

  const [exportBusy, setExportBusy] = useState(false);

  const isBusy = importBusy || exportBusy;

  // A one-time export does not need live page subscriptions: walk the export
  // cursor directly and let each page drop after it is consumed.
  async function handleExport() {
    if (!activeCompanyId || !active || exportBusy) return;
    setExportBusy(true);
    try {
      const rows: any[] = [];
      let cursor: string | null = null;
      let isDone = false;
      while (!isDone) {
        const page: { page: any[]; continueCursor: string; isDone: boolean } = await convex.query(api.tasks.exportRows, {
          companyId: activeCompanyId,
          kind: taskKind(kind),
          paginationOpts: { numItems: 200, cursor },
        });
        rows.push(...page.page);
        cursor = page.continueCursor;
        isDone = page.isDone;
      }
      const { exportTaskWorkbook, downloadBlob } = await loadWorkbook();
      const workbook = await exportTaskWorkbook(taskKind(kind), activeCompanyId, active.company.name, rows);
      downloadBlob(await workbook.toBlob(), `${kind === "jd" ? "jd-tasks" : "one-time-tasks"}.xlsx`);
      onNotification?.({
        type: "success",
        message: `Successfully exported ${rows.length} task${rows.length === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      onNotification?.({
        type: "error",
        message: err instanceof Error ? err.message : "Could not export tasks.",
      });
    } finally {
      setExportBusy(false);
    }
  }

  async function handleFile(file: File) {
    if (!activeCompanyId) return;
    setImportBusy(true);
    setFileName(file.name);
    const importKey = crypto.randomUUID();
    try {
      const { parseWorkbook } = await loadWorkbook();
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
      // All-or-nothing: any row that fails validation blocks the import and the
      // file must be fixed and uploaded again.
      if (nextRows.some(rowBlocksImport)) {
        setRows(nextRows);
        setIssuesOpen(true);
      } else {
        await executeImport(nextRows, importKey);
      }
    } catch (err) {
      onNotification?.({
        type: "error",
        message: err instanceof Error ? err.message : "Could not import workbook.",
      });
    } finally {
      setImportBusy(false);
    }
  }

  // One mutation per import: the commit either writes every row or nothing.
  async function executeImport(rowsToImport: ReviewRow[], importKey: string) {
    if (!activeCompanyId) return;
    setImportBusy(true);
    try {
      const result = await commit({
        companyId: activeCompanyId,
        kind: taskKind(kind),
        importKey,
        batchKey: `${importKey}:0`,
        source: "cendro",
        rows: rowsToImport.map((row) => ({
          draft: row.draft,
          include: true,
          expectedUpdatedAt: row.current?.updatedAt,
          selectedAssigneeMembershipIds:
            row.draft.assigneeEmails.length || row.draft.rawAssigneeText.trim()
              ? (row.proposedAssigneeMembershipIds as Id<"companyMemberships">[])
              : null,
        })),
      });
      onNotification?.({
        type: "success",
        message: `Successfully imported ${rowsToImport.length} task${rowsToImport.length === 1 ? "" : "s"} (${result.created} created, ${result.updated} updated).`,
      });
    } catch (err) {
      onNotification?.({
        type: "error",
        message: `Nothing was imported. ${err instanceof Error ? err.message : "Import failed."}`,
      });
    } finally {
      setImportBusy(false);
    }
  }

  const issueRows = rows.filter((r) => rowBlocksImport(r) || r.warnings.length > 0);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="secondary"
            size="sm"
            className="whitespace-nowrap"
            disabled={isBusy || !activeCompanyId}
            aria-label="Import or export tasks"
          >
            {isBusy ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUpDown className="h-4 w-4" />
            )}
            <span>
              {exportBusy
                ? "Exporting..."
                : importBusy
                ? "Importing..."
                : "Import / Export"}
            </span>
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className="task-menu min-w-44">
            {canImport && (
              <DropdownMenu.Item
                className="task-menu-item"
                disabled={isBusy}
                onSelect={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
                <span>Import tasks</span>
              </DropdownMenu.Item>
            )}
            {canExport && (
              <DropdownMenu.Item
                className="task-menu-item"
                disabled={isBusy}
                onSelect={() => void handleExport()}
              >
                <Download className="h-4 w-4" />
                <span>Export tasks</span>
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

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

      <Dialog.Root open={issuesOpen} onOpenChange={setIssuesOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
          <Dialog.Content
            className="fixed inset-3 z-50 flex max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-elevated)] md:inset-y-12 md:left-1/2 md:w-full md:-translate-x-1/2"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--hairline)] px-5 py-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-[var(--badge-red-fg)]" />
                <div>
                  <Dialog.Title className="text-[15px] font-semibold">Import Blocked</Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                    {fileName} · {issueRows.length} of {rows.length} rows have issues
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
              <div className="flex items-start gap-2 rounded-lg bg-[var(--surface-muted)] p-3 text-[13px] text-[var(--ink-muted)]">
                <span>
                  Nothing was imported. Fix these rows in the original file, then upload the file again.
                </span>
              </div>

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
                            {row.reference || "Missing Code"}
                          </span>
                          <span className="text-[11px] text-[var(--ink-muted)]">
                            {row.sourceSheet} · row {row.sourceRow}
                          </span>
                        </div>
                        <p className="mt-1 text-[13px] font-medium text-[var(--ink)]">
                          {row.draft.title || "(Untitled task)"}
                        </p>
                      </div>

                      <span
                        className={cn(
                          "rounded px-2 py-0.5 text-[11px] font-medium",
                          rowBlocksImport(row)
                            ? "bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]"
                            : "bg-[var(--badge-yellow-bg)] text-[var(--badge-yellow-fg)]"
                        )}
                      >
                        {rowBlocksImport(row) ? "Blocked" : "Warning"}
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
                  </div>
                ))}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-end border-t border-[var(--hairline)] px-5 py-4">
              <Dialog.Close asChild>
                <Button variant="primary" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
