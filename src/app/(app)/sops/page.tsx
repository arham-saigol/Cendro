"use client";

import Link from "next/link";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
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
  const [optimisticSops, setOptimisticSops] = useState<any[]>([]);
  const rows = [...optimisticSops, ...((sopQuery.results as any[]) ?? [])];

  async function createSop() {
    const trimmedTitle = title.trim();
    if (!activeCompanyId || !trimmedTitle || isCreating) return;
    const optimistic = { _id: crypto.randomUUID(), title: trimmedTitle, scopeType: "company", updatedAt: Date.now() };
    setOptimisticSops((current) => [optimistic, ...current]);
    setIsCreating(true);
    try {
      await create({ companyId: activeCompanyId, title: trimmedTitle, content, scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });
      setTitle("");
      setContent("");
    } finally {
      setIsCreating(false);
      setOptimisticSops((current) => current.filter((sop) => sop._id !== optimistic._id));
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6"><div className="text-4xl">📄</div><h1 className="text-[32px] font-bold">SOPs</h1><p className="text-[var(--ink-muted)]">Searchable operating procedures with company, branch, department, and user visibility.</p></div>
      <Card className="mb-4 p-3"><div className="grid gap-2"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="SOP title" /><Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="SOP body" /><Button variant="primary" disabled={isCreating} onClick={createSop}>{isCreating ? "Creating…" : "Create SOP"}</Button></div></Card>
      <Card><table className="notion-table"><tbody>{rows.map((s: any) => <tr key={s._id}><td className="px-3 font-medium"><Link href={`/sops/${s._id}`}>{s.title}</Link></td><td><Badge>{s.scopeType}</Badge></td><td className="text-[var(--ink-muted)]">Updated {new Date(s.updatedAt).toLocaleDateString()}</td></tr>)}</tbody></table></Card>
      {sopQuery.status === "CanLoadMore" && <Button className="mt-4" onClick={() => sopQuery.loadMore(25)}>Load more</Button>}
    </div>
  );
}
