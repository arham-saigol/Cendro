"use client";

import Link from "next/link";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "./company-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

export function TaskList({ kind }: { kind: "jd" | "one" }) {
  const { activeCompanyId } = useCompany();
  const taskQuery = usePaginatedQuery(kind === "jd" ? api.tasks.listJd : api.tasks.listOneTime, activeCompanyId ? { companyId: activeCompanyId } : "skip", { initialNumItems: 25 });
  const tasks = taskQuery.results as any[];
  const assignable = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: kind === "jd" ? "jd" : "one_time" } : "skip") as any[] | undefined;
  const createJd = useMutation(api.tasks.createJd);
  const createOne = useMutation(api.tasks.createOneTime);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [optimisticTasks, setOptimisticTasks] = useState<any[]>([]);
  const defaultAssigneeId = assigneeId || assignable?.[0]?.membership._id;
  const displayTasks = [...optimisticTasks, ...(tasks ?? [])];

  async function create() {
    if (!activeCompanyId || !defaultAssigneeId || !title.trim()) return;
    const currentTitle = title.trim();
    const assignee = assignable?.find((a) => a.membership._id === defaultAssigneeId);
    const tempId = crypto.randomUUID();
    const optimistic = { _id: tempId, title: currentTitle, state: kind === "jd" ? { status: "Due" } : "Upcoming", recurrence: "daily", dueDate: Date.now() + 86_400_000, priority: "medium", assignees: assignee ? [assignee] : [] };
    setOptimisticTasks((current) => [optimistic, ...current]);
    setTitle("");
    try {
      if (kind === "jd") await createJd({ companyId: activeCompanyId, title: currentTitle, description: "", recurrence: "daily", startDate: Date.now(), assigneeMembershipIds: [defaultAssigneeId as Id<"companyMemberships">], priority: "medium" });
      else await createOne({ companyId: activeCompanyId, title: currentTitle, description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [defaultAssigneeId as Id<"companyMemberships">], priority: "medium" });
    } catch (err) {
      setTitle(currentTitle);
      throw err;
    } finally {
      setOptimisticTasks((current) => current.filter((t) => t._id !== tempId));
    }
  }

  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";
  return (
    <div className="p-8">
      <div className="mb-6"><div className="text-4xl">{kind === "jd" ? "🔁" : "☑️"}</div><h1 className="text-[32px] font-bold">{kind === "jd" ? "JD tasks" : "One-time tasks"}</h1><p className="text-[var(--ink-muted)]">Permission-filtered task database with comments, completion, and overdue behavior.</p></div>
      {!!assignable?.length && <Card className="mb-4 p-3"><div className="grid gap-2 md:grid-cols-[1fr_220px_auto]"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title" /><select value={defaultAssigneeId ?? ""} onChange={(e) => setAssigneeId(e.target.value)} className="h-8 rounded-[5px] border border-[var(--hairline)] bg-[var(--surface)] px-2 text-sm">{assignable.map((a) => <option key={a.membership._id} value={a.membership._id}>{a.user.name || a.user.email}</option>)}</select><Button onClick={create} variant="primary">Create task</Button></div></Card>}
      <Card><table className="notion-table"><thead><tr><th className="px-3">Title</th><th>Status</th><th>Assignees</th><th>{kind === "jd" ? "Recurrence" : "Due"}</th><th>Priority</th></tr></thead><tbody>{displayTasks.map((t) => <tr key={t._id}><td className="px-3 font-medium"><Link href={`${base}/${t._id}`}>{t.title}</Link></td><td><Badge tone={t.state.status === "Overdue" || t.state === "Overdue" ? "red" : t.state.status === "Done" || t.state === "Done" ? "green" : "blue"}>{t.state.status || t.state}</Badge></td><td>{t.assignees.map((a: any) => a.user.name || a.user.email).join(", ")}</td><td className="text-[var(--ink-muted)]">{kind === "jd" ? t.recurrence.replaceAll("_", " ") : formatDate(t.dueDate)}</td><td><Badge>{t.priority}</Badge></td></tr>)}</tbody></table></Card>
      {taskQuery.status === "CanLoadMore" && <Button className="mt-4" onClick={() => taskQuery.loadMore(25)}>Load more</Button>}
    </div>
  );
}

export function TaskDetail({ kind, id }: { kind: "jd" | "one"; id: string }) {
  const { activeCompanyId } = useCompany();
  const taskType = kind === "jd" ? "jd" : "one_time";
  const data = useQuery(kind === "jd" ? api.tasks.getJd : api.tasks.getOneTime, activeCompanyId ? { companyId: activeCompanyId, taskId: id as any } : "skip") as any;
  const commentsQuery = usePaginatedQuery(api.tasks.listComments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip", { initialNumItems: 25 });
  const attachments = useQuery(api.tasks.listAttachments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip") as any[] | undefined;
  const complete = useMutation(kind === "jd" ? api.tasks.completeJd : api.tasks.completeOneTime);
  const comment = useMutation(api.tasks.addComment);
  const generateUploadUrl = useMutation(api.tasks.generateAttachmentUploadUrl);
  const addAttachment = useMutation(api.tasks.addAttachment);
  const deleteAttachment = useMutation(api.tasks.deleteAttachment);
  const [body, setBody] = useState("");
  const [uploading, setUploading] = useState(false);
  const [optimisticDone, setOptimisticDone] = useState(false);
  const [optimisticComments, setOptimisticComments] = useState<any[]>([]);
  if (!data) return <div className="p-8">Loading task…</div>;
  const t = optimisticDone ? { ...data.task, state: kind === "jd" ? { ...data.task.state, status: "Done" } : "Done" } : data.task;
  const comments = [...optimisticComments, ...(commentsQuery.results as any[])];

  async function upload(file: File) {
    if (!activeCompanyId) return;
    setUploading(true);
    try {
      const postUrl = await generateUploadUrl({ companyId: activeCompanyId });
      const result = await fetch(postUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      const { storageId } = await result.json();
      await addAttachment({ companyId: activeCompanyId, taskType, taskId: id, storageId, fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="text-4xl">{kind === "jd" ? "🔁" : "☑️"}</div><h1 className="text-[32px] font-bold">{t.title}</h1><div className="mt-3 flex gap-2"><Badge tone={(t.state.status || t.state) === "Overdue" ? "red" : "blue"}>{t.state.status || t.state}</Badge><Badge>{t.priority}</Badge></div><p className="mt-6 whitespace-pre-wrap text-[var(--ink-secondary)]">{t.description || "No description."}</p>
      <Button className="mt-5" variant="primary" onClick={async () => { setOptimisticDone(true); try { await complete({ companyId: activeCompanyId as Id<"companies">, taskId: id as any }); } catch (err) { setOptimisticDone(false); throw err; } }}>Mark as done</Button>
      <section className="mt-8 border-t pt-6"><h2 className="font-semibold">Comments</h2><div className="mt-3 space-y-2">{comments.map((c: any) => <div key={c._id} className="rounded-md bg-[var(--surface-muted)] p-3 text-sm">{c.body}</div>)}</div>{commentsQuery.status === "CanLoadMore" && <Button className="mt-3" size="sm" onClick={() => commentsQuery.loadMore(25)}>Load more comments</Button>}<div className="mt-3 flex gap-2"><Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment…" /><Button onClick={async () => { const text = body.trim(); if (text) { const tempId = crypto.randomUUID(); setOptimisticComments((current) => [{ _id: tempId, body: text }, ...current]); setBody(""); try { await comment({ companyId: activeCompanyId as Id<"companies">, taskType, taskId: id, body: text }); } catch (err) { setBody(text); throw err; } finally { setOptimisticComments((current) => current.filter((c) => c._id !== tempId)); } } }}>Comment</Button></div>
        <h2 className="mt-8 font-semibold">Attachments</h2><div className="mt-3 space-y-2">{(attachments ?? []).map((a) => <div key={a._id} className="flex items-center justify-between rounded-md border p-2 text-sm"><a className="text-[var(--primary)]" href={a.url ?? "#"} target="_blank" rel="noreferrer">{a.fileName}</a><Button size="sm" variant="ghost" onClick={() => deleteAttachment({ companyId: activeCompanyId as Id<"companies">, attachmentId: a._id })}>Delete</Button></div>)}</div><Input className="mt-3" type="file" disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.currentTarget.value = ""; }} />
      </section>
    </div>
  );
}
