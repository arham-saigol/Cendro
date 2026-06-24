"use client";

import Link from "next/link";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import { PageHeader } from "@/components/app/page-header";
import { useCompany } from "@/components/app/company-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function Sops() {
  const { activeCompanyId } = useCompany();
  const sopQuery = usePaginatedQuery(api.sops.list, activeCompanyId ? { companyId: activeCompanyId } : "skip", { initialNumItems: 25 });
  const create = useMutation(api.sops.create);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [optimisticSops, setOptimisticSops] = useState<any[]>([]);
  const rows = [...optimisticSops, ...((sopQuery.results as any[]) ?? [])];

  async function createSop() {
    const trimmedTitle = title.trim();
    if (!activeCompanyId || !trimmedTitle || isCreating) return;
    const optimistic = { _id: crypto.randomUUID(), title: trimmedTitle, scopeType: "company", updatedAt: Date.now(), _optimistic: true };
    setCreateError(null);
    setOptimisticSops((current) => [optimistic, ...current]);
    setIsCreating(true);
    try {
      await create({ companyId: activeCompanyId, title: trimmedTitle, content, scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });
      setTitle("");
      setContent("");
      setCreateError(null);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create SOP.");
    } finally {
      setIsCreating(false);
      setOptimisticSops((current) => current.filter((sop) => sop._id !== optimistic._id));
    }
  }

  return (
    <div className="app-page">
      <PageHeader
        title="SOPs"
        description="Searchable operating procedures with company, branch, department, and user visibility."
      />

      <Card className="mb-4 p-3">
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-xs font-medium text-[var(--ink-muted)]">
            SOP title
            <Input value={title} onChange={(event) => { setTitle(event.target.value); setCreateError(null); }} placeholder="New procedure title" />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-[var(--ink-muted)]">
            Body
            <Textarea value={content} onChange={(event) => { setContent(event.target.value); setCreateError(null); }} placeholder="Write the procedure..." />
          </label>
          {createError && <p className="alert-error rounded-md p-2 text-sm">{createError}</p>}
          <div><Button variant="primary" disabled={isCreating || !title.trim()} onClick={createSop}>{isCreating ? "Creating..." : "Create SOP"}</Button></div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {sopQuery.status === "LoadingFirstPage" ? (
          <div className="animate-pulse space-y-3 p-4">
            <div className="h-5 w-1/3 rounded bg-[var(--surface-muted)]" />
            <div className="h-10 rounded bg-[var(--surface-muted)]" />
            <div className="h-10 rounded bg-[var(--surface-muted)]" />
            <div className="h-10 rounded bg-[var(--surface-muted)]" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5 text-sm text-[var(--ink-muted)]">No SOPs yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="notion-table">
              <thead><tr><th>Title</th><th>Scope</th><th>Updated</th></tr></thead>
              <tbody>
                {rows.map((sop: any) => (
                  <tr key={sop._id}>
                    <td className="min-w-[260px] font-medium text-[var(--ink)]">{sop._optimistic ? <span>{sop.title}</span> : <Link className="hover:text-[var(--primary)]" href={`/sops/${sop._id}`}>{sop.title}</Link>}</td>
                    <td><Badge>{sop.scopeType}</Badge></td>
                    <td className="text-[var(--ink-muted)]">{new Date(sop.updatedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {sopQuery.status === "CanLoadMore" && <Button className="mt-4" onClick={() => sopQuery.loadMore(25)}>Load more</Button>}
    </div>
  );
}
