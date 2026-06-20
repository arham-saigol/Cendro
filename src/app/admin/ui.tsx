"use client";

import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type CompanyRow = {
  company: { _id: Id<"companies"> | `temp-${string}`; name: string; deletedAt?: number };
  memberCount: number;
};

function isCompanyId(id: string): id is Id<"companies"> {
  return !id.startsWith("temp-");
}

function AdminSkeleton() {
  return (
    <main className="min-h-screen bg-[var(--canvas-soft)] p-8">
      <div className="mx-auto max-w-5xl animate-pulse">
        <div className="h-10 w-64 rounded bg-[var(--surface-pressed)]" />
        <div className="mt-2 h-4 w-full max-w-3xl rounded bg-[var(--surface-pressed)]" />
        <Card className="my-6 p-4">
          <div className="mb-3 h-5 w-36 rounded bg-[var(--surface-pressed)]" />
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
            <div className="h-10 rounded bg-[var(--surface-pressed)]" />
            <div className="h-10 rounded bg-[var(--surface-pressed)]" />
            <div className="h-10 w-36 rounded bg-[var(--surface-pressed)]" />
          </div>
        </Card>
        <Card className="p-4">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3">
            {[0, 1, 2, 3, 4].map((row) => <div key={row} className="contents">
              <div className="h-5 rounded bg-[var(--surface-pressed)]" />
              <div className="h-5 rounded bg-[var(--surface-pressed)]" />
              <div className="h-5 rounded bg-[var(--surface-pressed)]" />
              <div className="h-5 rounded bg-[var(--surface-pressed)]" />
            </div>)}
          </div>
        </Card>
      </div>
    </main>
  );
}

export function AdminClient() {
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const [companyLimit, setCompanyLimit] = useState(25);
  const dashboard = useQuery(api.platform.adminDashboard, isAuthenticated ? { companyLimit } : "skip");
  const access = dashboard?.access;
  const companies = dashboard?.companies;
  const create = useAction(api.platform.createCompany);
  const del = useMutation(api.platform.deleteCompany);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [optimisticCreates, setOptimisticCreates] = useState<CompanyRow[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const deleting = deletingIds;
    return [
      ...optimisticCreates,
      ...(companies ?? []).map((row) => deleting.has(row.company._id) ? { ...row, company: { ...row.company, deletedAt: row.company.deletedAt ?? 1 } } : row),
    ];
  }, [companies, deletingIds, optimisticCreates]);

  async function createCompany() {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName || !trimmedEmail || creating || !access?.isAdmin) return;
    const tempId = `temp-${crypto.randomUUID()}` as `temp-${string}`;
    const optimistic: CompanyRow = { company: { _id: tempId, name: trimmedName }, memberCount: 0 };
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

  async function deleteCompany(row: CompanyRow) {
    const companyId = row.company._id;
    if (!isCompanyId(companyId)) return;
    const confirmation = prompt(`Type ${row.company.name} to delete`);
    if (!confirmation || deletingIds.has(companyId) || !access?.isAdmin) return;
    setError(null);
    setDeletingIds((current) => new Set(current).add(companyId));
    try {
      await del({ companyId, confirmation });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete company.");
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(companyId);
        return next;
      });
    }
  }

  if (authLoading) {
    return <AdminSkeleton />;
  }

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-[var(--canvas-soft)] p-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-[32px] font-bold">Platform admin</h1>
          <Card className="mt-6 p-4">
            <h2 className="font-semibold">Could not authenticate with Convex</h2>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">You are signed in with Clerk, but Convex has not accepted the session yet. Check the Convex Clerk JWT configuration.</p>
          </Card>
        </div>
      </main>
    );
  }

  if (dashboard === undefined) {
    return <AdminSkeleton />;
  }

  if (!access?.isAdmin) {
    return (
      <main className="min-h-screen bg-[var(--canvas-soft)] p-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-[32px] font-bold">Platform admin</h1>
          <Card className="mt-6 p-4">
            <h2 className="font-semibold">No platform admin access</h2>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Your browser session is signed in, but Convex does not recognize this account as the configured platform admin.</p>
            {access?.email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {access.email}</p>}
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-soft)] p-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-[32px] font-bold">Platform admin</h1>
        <p className="text-[var(--ink-muted)]">Hidden owner-only route. Company deletion is a soft delete: child records remain for audit and the company becomes inaccessible.</p>
        {error && <p className="alert-error mt-4 rounded-md p-3 text-sm">{error}</p>}
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
            <tbody>{rows.map((r) => <tr key={r.company._id}>
              <td className="px-3 font-medium">{r.company.name}</td>
              <td>{r.memberCount}</td>
              <td><Badge tone={r.company.deletedAt ? "red" : "green"}>{r.company.deletedAt ? "Deleted" : "Active"}</Badge></td>
              <td><Button variant="danger" size="sm" disabled={deletingIds.has(r.company._id) || r.company._id.startsWith("temp-")} onClick={() => deleteCompany(r)}>{deletingIds.has(r.company._id) ? "Deleting…" : "Delete"}</Button></td>
            </tr>)}</tbody>
          </table>
        </Card>
        {dashboard.hasMore && <Button className="mt-4" onClick={() => setCompanyLimit((limit) => limit + 25)}>Load more</Button>}
      </div>
    </main>
  );
}
