"use client";

import Link from "next/link";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PageHeader } from "./page-header";
import { useCompany } from "./company-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/utils";

function statusText(task: any) {
  return typeof task.state === "string" ? task.state : task.state.status;
}

function statusTone(status: string) {
  if (status === "Overdue") return "red";
  if (status === "Done") return "green";
  return "blue";
}

export function TaskList({ kind }: { kind: "jd" | "one" }) {
  const { activeCompanyId, active } = useCompany();
  const taskQuery = usePaginatedQuery(kind === "jd" ? api.tasks.listJd : api.tasks.listOneTime, activeCompanyId ? { companyId: activeCompanyId } : "skip", { initialNumItems: 25 });
  const tasks = taskQuery.results as any[] | undefined;
  const assignable = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: kind === "jd" ? "jd" : "one_time" } : "skip") as any[] | undefined;
  const createJd = useMutation(api.tasks.createJd);
  const createOne = useMutation(api.tasks.createOneTime);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [optimisticTasks, setOptimisticTasks] = useState<any[]>([]);
  const defaultAssigneeId = assigneeId || assignable?.[0]?.membership._id;
  const displayTasks = [...optimisticTasks, ...((tasks ?? []) as any[])];
  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";
  const pageTitle = kind === "jd" ? "JD tasks" : "One-time tasks";
  const description = kind === "jd"
    ? "Recurring responsibilities and operating work for each role."
    : "One-off work with due dates, ownership, and completion history.";

  async function create() {
    if (!activeCompanyId || !defaultAssigneeId || !title.trim() || isCreating) return;
    const currentTitle = title.trim();
    const assignee = assignable?.find((candidate) => candidate.membership._id === defaultAssigneeId);
    const tempId = crypto.randomUUID();
    const optimistic = {
      _id: tempId,
      title: currentTitle,
      state: kind === "jd" ? { status: "Due" } : "Upcoming",
      recurrence: "daily",
      dueDate: Date.now() + 86_400_000,
      priority: "medium",
      assignees: assignee ? [assignee] : [],
      _optimistic: true,
    };
    setCreateError(null);
    setIsCreating(true);
    setOptimisticTasks((current) => [optimistic, ...current]);
    setTitle("");
    try {
      if (kind === "jd") await createJd({ companyId: activeCompanyId, title: currentTitle, description: "", recurrence: "daily", startDate: Date.now(), assigneeMembershipIds: [defaultAssigneeId as Id<"companyMemberships">], priority: "medium" });
      else await createOne({ companyId: activeCompanyId, title: currentTitle, description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [defaultAssigneeId as Id<"companyMemberships">], priority: "medium" });
    } catch (err) {
      setTitle(currentTitle);
      setCreateError(err instanceof Error ? err.message : "Could not create task.");
    } finally {
      setIsCreating(false);
      setOptimisticTasks((current) => current.filter((task) => task._id !== tempId));
    }
  }

  return (
    <div className="app-page">
      <PageHeader eyebrow={active?.company.name ?? "Tasks"} title={pageTitle} description={description} />

      {!!assignable?.length && (
        <Card className="mb-4 p-3">
          <div className="grid gap-3 md:grid-cols-[1fr_230px_auto] md:items-end">
            <label className="grid gap-1.5 text-xs font-medium text-[var(--ink-muted)]">
              Task title
              <Input value={title} onChange={(event) => { setTitle(event.target.value); setCreateError(null); }} placeholder="New task title" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-[var(--ink-muted)]">
              Assignee
              <select value={defaultAssigneeId ?? ""} onChange={(event) => setAssigneeId(event.target.value)} className="form-select">
                {assignable.map((assignee) => <option key={assignee.membership._id} value={assignee.membership._id}>{assignee.user.name || assignee.user.email}</option>)}
              </select>
            </label>
            <Button onClick={create} variant="primary" disabled={!title.trim() || isCreating}>
              {isCreating ? "Creating..." : "Create task"}
            </Button>
          </div>
          {createError && <p className="alert-error mt-3 rounded-md p-2 text-sm">{createError}</p>}
        </Card>
      )}

      <Card className="overflow-hidden">
        {taskQuery.status === "LoadingFirstPage" ? (
          <div className="animate-pulse space-y-3 p-4">
            <div className="h-5 w-1/3 rounded bg-[var(--surface-muted)]" />
            <div className="h-10 rounded bg-[var(--surface-muted)]" />
            <div className="h-10 rounded bg-[var(--surface-muted)]" />
            <div className="h-10 rounded bg-[var(--surface-muted)]" />
          </div>
        ) : displayTasks.length === 0 ? (
          <div className="p-5 text-sm text-[var(--ink-muted)]">No tasks yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="notion-table">
              <thead>
                <tr><th>Title</th><th>Status</th><th>Assignees</th><th>{kind === "jd" ? "Recurrence" : "Due"}</th><th>Priority</th></tr>
              </thead>
              <tbody>
                {displayTasks.map((task) => {
                  const status = statusText(task);
                  return (
                    <tr key={task._id}>
                      <td className="min-w-[260px] font-medium text-[var(--ink)]">{task._optimistic ? <span>{task.title}</span> : <Link className="hover:text-[var(--primary)]" href={`${base}/${task._id}`}>{task.title}</Link>}</td>
                      <td><Badge tone={statusTone(status)}>{status}</Badge></td>
                      <td className="min-w-[180px]">{task.assignees.map((assignee: any) => assignee.user.name || assignee.user.email).join(", ")}</td>
                      <td className="text-[var(--ink-muted)]">{kind === "jd" ? task.recurrence.replaceAll("_", " ") : formatDate(task.dueDate)}</td>
                      <td><Badge>{task.priority}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {taskQuery.status === "CanLoadMore" && <Button className="mt-4" onClick={() => taskQuery.loadMore(25)}>Load more</Button>}
    </div>
  );
}

function TaskDetailSkeleton() {
  return (
    <div className="app-page app-page-narrow animate-pulse">
      <div className="h-8 w-2/3 rounded bg-[var(--surface-muted)]" />
      <div className="mt-3 flex gap-2"><div className="h-6 w-20 rounded bg-[var(--surface-muted)]" /><div className="h-6 w-16 rounded bg-[var(--surface-muted)]" /></div>
      <div className="mt-6 h-24 rounded bg-[var(--surface-muted)]" />
      <div className="mt-8 border-t border-[var(--hairline)] pt-6"><div className="h-5 w-28 rounded bg-[var(--surface-muted)]" /></div>
    </div>
  );
}

export function TaskDetail({ kind, id }: { kind: "jd" | "one"; id: string }) {
  const { activeCompanyId, active } = useCompany();
  const taskType = kind === "jd" ? "jd" : "one_time";
  const data = useQuery(kind === "jd" ? api.tasks.getJd : api.tasks.getOneTime, activeCompanyId ? { companyId: activeCompanyId, taskId: id as any } : "skip") as any;
  const commentsQuery = usePaginatedQuery(api.tasks.listComments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip", { initialNumItems: 25 });
  const attachmentsQuery = usePaginatedQuery(api.tasks.listAttachments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip", { initialNumItems: 25 });
  const attachments = attachmentsQuery.results as any[] | undefined;
  const complete = useMutation(kind === "jd" ? api.tasks.completeJd : api.tasks.completeOneTime);
  const comment = useMutation(api.tasks.addComment);
  const generateUploadUrl = useMutation(api.tasks.generateAttachmentUploadUrl);
  const addAttachment = useMutation(api.tasks.addAttachment);
  const deleteAttachment = useMutation(api.tasks.deleteAttachment);
  const [body, setBody] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [optimisticDone, setOptimisticDone] = useState(false);
  const [optimisticComments, setOptimisticComments] = useState<any[]>([]);

  if (!data) return <TaskDetailSkeleton />;
  const task = optimisticDone ? { ...data.task, state: kind === "jd" ? { ...data.task.state, status: "Done" } : "Done" } : data.task;
  const status = statusText(task);
  const comments = [...optimisticComments, ...(commentsQuery.results as any[])];

  async function upload(file: File) {
    if (!activeCompanyId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const postUrl = await generateUploadUrl({ companyId: activeCompanyId });
      const response = await fetch(postUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!response.ok) throw new Error("Upload failed.");
      let json: { storageId?: Id<"_storage"> };
      try {
        json = await response.json();
      } catch {
        throw new Error("Upload failed.");
      }
      if (!json.storageId) throw new Error("Upload failed.");
      await addAttachment({ companyId: activeCompanyId, taskType, taskId: id, storageId: json.storageId, fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="app-page app-page-narrow">
      <PageHeader
        eyebrow={active?.company.name ?? (kind === "jd" ? "JD task" : "One-time task")}
        title={task.title}
        description={task.description || "No description."}
        actions={<Button variant="primary" onClick={async () => { setActionError(null); setOptimisticDone(true); try { await complete({ companyId: activeCompanyId as Id<"companies">, taskId: id as any }); } catch (err) { setOptimisticDone(false); setActionError(err instanceof Error ? err.message : "Could not mark task as done."); } }}>Mark as done</Button>}
      />
      {actionError && <p className="alert-error mb-4 rounded-md p-2 text-sm">{actionError}</p>}
      <div className="mb-6 flex gap-2"><Badge tone={statusTone(status)}>{status}</Badge><Badge>{task.priority}</Badge></div>

      <section className="border-t border-[var(--hairline)] pt-6">
        <h2 className="text-sm font-semibold">Comments</h2>
        <div className="mt-3 space-y-2">
          {comments.length === 0 && <div className="rounded-md border border-[var(--hairline)] p-3 text-sm text-[var(--ink-muted)]">No comments yet.</div>}
          {comments.map((commentRow: any) => <div key={commentRow._id} className="rounded-md bg-[var(--surface-muted)] p-3 text-sm text-[var(--ink-secondary)]">{commentRow.body}</div>)}
        </div>
        {commentsQuery.status === "CanLoadMore" && <Button className="mt-3" size="sm" onClick={() => commentsQuery.loadMore(25)}>Load more comments</Button>}
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
          <Textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Add a comment..." />
          <Button onClick={async () => { const text = body.trim(); if (text) { const tempId = crypto.randomUUID(); setActionError(null); setOptimisticComments((current) => [{ _id: tempId, body: text }, ...current]); setBody(""); try { await comment({ companyId: activeCompanyId as Id<"companies">, taskType, taskId: id, body: text }); } catch (err) { setBody(text); setActionError(err instanceof Error ? err.message : "Could not add comment."); } finally { setOptimisticComments((current) => current.filter((commentRow) => commentRow._id !== tempId)); } } }}>Comment</Button>
        </div>
        <h2 className="mt-8 text-sm font-semibold">Attachments</h2>
        <div className="mt-3 space-y-2">
          {(attachments ?? []).length === 0 && <div className="rounded-md border border-[var(--hairline)] p-3 text-sm text-[var(--ink-muted)]">No attachments yet.</div>}
          {(attachments ?? []).map((attachment) => (
            <div key={attachment._id} className="flex items-center justify-between rounded-md border border-[var(--hairline)] p-2 text-sm">
              <a className="text-[var(--primary)]" href={attachment.url ?? "#"} target="_blank" rel="noreferrer">{attachment.fileName}</a>
              <Button size="sm" variant="ghost" onClick={() => deleteAttachment({ companyId: activeCompanyId as Id<"companies">, attachmentId: attachment._id })}>Delete</Button>
            </div>
          ))}
        </div>
        {attachmentsQuery.status === "CanLoadMore" && <Button className="mt-3" size="sm" onClick={() => attachmentsQuery.loadMore(25)}>Load more attachments</Button>}
        {uploadError && <p className="alert-error mt-3 rounded-md p-2 text-sm">{uploadError}</p>}
        <Input className="mt-3" type="file" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} />
      </section>
    </div>
  );
}
