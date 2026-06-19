"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
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
  const tasks = useQuery(kind === "jd" ? api.tasks.listJd : api.tasks.listOneTime, activeCompanyId ? { companyId: activeCompanyId } : "skip") as any[] | undefined;
  const assignable = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: kind === "jd" ? "jd" : "one_time" } : "skip") as any[] | undefined;
  const createJd = useMutation(api.tasks.createJd);
  const createOne = useMutation(api.tasks.createOneTime);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const defaultAssigneeId = assigneeId || assignable?.[0]?.membership._id;

  async function create() {
    if (!activeCompanyId || !defaultAssigneeId || !title.trim()) return;
    if (kind === "jd") {
      await createJd({ companyId: activeCompanyId, title, description: "", recurrence: "daily", startDate: Date.now(), assigneeMembershipIds: [defaultAssigneeId as Id<"companyMemberships">], priority: "medium" });
    } else {
      await createOne({ companyId: activeCompanyId, title, description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [defaultAssigneeId as Id<"companyMemberships">], priority: "medium" });
    }
    setTitle("");
  }

  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";
  return (
    <div className="p-8">
      <div className="mb-6">
        <div className="text-4xl">{kind === "jd" ? "🔁" : "☑️"}</div>
        <h1 className="text-[32px] font-bold">{kind === "jd" ? "JD tasks" : "One-time tasks"}</h1>
        <p className="text-[var(--ink-muted)]">Permission-filtered task database with comments, completion, and overdue behavior.</p>
      </div>
      {!!assignable?.length && (
        <Card className="mb-4 p-3">
          <div className="grid gap-2 md:grid-cols-[1fr_220px_auto]">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title" />
            <select value={defaultAssigneeId ?? ""} onChange={(e) => setAssigneeId(e.target.value)} className="h-8 rounded-[5px] border border-[var(--hairline)] bg-[var(--surface)] px-2 text-sm">
              {assignable.map((a) => <option key={a.membership._id} value={a.membership._id}>{a.user.name || a.user.email}</option>)}
            </select>
            <Button onClick={create} variant="primary">Create task</Button>
          </div>
        </Card>
      )}
      <Card>
        <table className="notion-table">
          <thead><tr><th className="px-3">Title</th><th>Status</th><th>Assignees</th><th>{kind === "jd" ? "Recurrence" : "Due"}</th><th>Priority</th></tr></thead>
          <tbody>
            {tasks?.map((t) => <tr key={t._id}>
              <td className="px-3 font-medium"><Link href={`${base}/${t._id}`}>{t.title}</Link></td>
              <td><Badge tone={t.state.status === "Overdue" || t.state === "Overdue" ? "red" : t.state.status === "Done" || t.state === "Done" ? "green" : "blue"}>{t.state.status || t.state}</Badge></td>
              <td>{t.assignees.map((a: any) => a.user.name || a.user.email).join(", ")}</td>
              <td className="text-[var(--ink-muted)]">{kind === "jd" ? t.recurrence.replaceAll("_", " ") : formatDate(t.dueDate)}</td>
              <td><Badge>{t.priority}</Badge></td>
            </tr>)}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function TaskDetail({ kind, id }: { kind: "jd" | "one"; id: string }) {
  const { activeCompanyId } = useCompany();
  const data = useQuery(kind === "jd" ? api.tasks.getJd : api.tasks.getOneTime, activeCompanyId ? { companyId: activeCompanyId, taskId: id as any } : "skip") as any;
  const complete = useMutation(kind === "jd" ? api.tasks.completeJd : api.tasks.completeOneTime);
  const comment = useMutation(api.tasks.addComment);
  const [body, setBody] = useState("");
  if (!data) return <div className="p-8">Loading task…</div>;
  const t = data.task;
  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="text-4xl">{kind === "jd" ? "🔁" : "☑️"}</div>
      <h1 className="text-[32px] font-bold">{t.title}</h1>
      <div className="mt-3 flex gap-2"><Badge tone={(t.state.status || t.state) === "Overdue" ? "red" : "blue"}>{t.state.status || t.state}</Badge><Badge>{t.priority}</Badge></div>
      <p className="mt-6 whitespace-pre-wrap text-[var(--ink-secondary)]">{t.description || "No description."}</p>
      <Button className="mt-5" variant="primary" onClick={() => complete({ companyId: activeCompanyId as Id<"companies">, taskId: id as any })}>Mark as done</Button>
      <section className="mt-8 border-t pt-6">
        <h2 className="font-semibold">Comments</h2>
        <div className="mt-3 space-y-2">{data.comments.map((c: any) => <div key={c._id} className="rounded-md bg-[var(--surface-muted)] p-3 text-sm">{c.body}</div>)}</div>
        <div className="mt-3 flex gap-2"><Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment…" /><Button onClick={async () => { if (body.trim()) { await comment({ companyId: activeCompanyId as Id<"companies">, taskType: kind === "jd" ? "jd" : "one_time", taskId: id, body }); setBody(""); } }}>Comment</Button></div>
        <h3 className="mt-6 text-sm font-semibold">Attachments foundation</h3>
        <p className="text-sm text-[var(--ink-muted)]">Attachment metadata is modeled in Convex; connect storage upload when a storage provider is selected.</p>
      </section>
    </div>
  );
}
