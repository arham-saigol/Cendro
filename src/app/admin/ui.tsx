"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function AdminClient() {
  const companies = useQuery(api.platform.listCompanies);
  const create = useAction(api.platform.createCompany);
  const del = useMutation(api.platform.deleteCompany);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [optimisticCreates, setOptimisticCreates] = useState<any[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const deleting = deletingIds;
    return [
      ...optimisticCreates,
      ...(companies ?? []).map((row: any) => deleting.has(row.company._id) ? { ...row, company: { ...row.company, deletedAt: row.company.deletedAt ?? 1 } } : row),
    ];
  }, [companies, deletingIds, optimisticCreates]);

  async function createCompany() {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail || creating) return;
    const tempId = `temp-${crypto.randomUUID()}`;
    const optimistic = { company: { _id: tempId, name: trimmedName }, memberCount: 0 };
    setError(null);
    setCreating(true);
    setOptimisticCreates((current) => [optimistic, ...current]);
    try {
      await create({ name: trimmedName, adminEmail: trimmedEmail });
      setName("");
      setEmail("");
      setOptimisticCreates((current) => current.filter((row) => row.company._id !== tempId));
    } catch (err) {
      setOptimisticCreates((current) => current.filter((row) => row.company._id !== tempId));
      setError(err instanceof Error ? err.message : "Could not create company.");
    } finally {
      setCreating(false);
    }
  }

  async function deleteCompany(row: any) {
    const confirmation = prompt(`Type ${row.company.name} to delete`);
    if (!confirmation || deletingIds.has(row.company._id)) return;
    setError(null);
    setDeletingIds((current) => new Set(current).add(row.company._id));
    try {
      await del({ companyId: row.company._id, confirmation });
    } catch (err) {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(row.company._id);
        return next;
      });
      setError(err instanceof Error ? err.message : "Could not delete company.");
    }
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-soft)] p-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-[32px] font-bold">Platform admin</h1>
        <p className="text-[var(--ink-muted)]">Hidden owner-only route. Company deletion is a soft delete: child records remain for audit and the company becomes inaccessible.</p>
        {error && <p className="mt-4 rounded-md border border-[#f3b6b0] bg-[#fff4f2] p-3 text-sm text-[#b42318]">{error}</p>}
        <Card className="my-6 p-4">
          <h2 className="mb-3 font-semibold">Create company</h2>
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name" />
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="First admin email" />
            <Button variant="primary" disabled={creating} onClick={createCompany}>{creating ? "Creating…" : "Create and invite"}</Button>
          </div>
        </Card>
        <Card>
          <table className="notion-table">
            <thead><tr><th className="px-3">Company</th><th>Members</th><th>Status</th><th>Delete</th></tr></thead>
            <tbody>{rows.map((r: any) => <tr key={r.company._id}>
              <td className="px-3 font-medium">{r.company.name}</td>
              <td>{r.memberCount}</td>
              <td><Badge tone={r.company.deletedAt ? "red" : "green"}>{r.company.deletedAt ? "Deleted" : "Active"}</Badge></td>
              <td><Button variant="danger" size="sm" disabled={deletingIds.has(r.company._id) || r.company._id.startsWith("temp-")} onClick={() => deleteCompany(r)}>{deletingIds.has(r.company._id) ? "Deleting…" : "Delete"}</Button></td>
            </tr>)}</tbody>
          </table>
        </Card>
      </div>
    </main>
  );
}
