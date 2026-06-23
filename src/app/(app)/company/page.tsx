"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { PageHeader } from "@/components/app/page-header";
import { useCompany } from "@/components/app/company-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function CompanySkeleton() {
  return (
    <div className="app-page animate-pulse">
      <div className="h-8 w-72 rounded bg-[var(--surface-muted)]" />
      <div className="mb-6 mt-3 h-5 w-[520px] max-w-full rounded bg-[var(--surface-muted)]" />
      <div className="flex gap-2"><div className="h-8 w-24 rounded bg-[var(--surface-muted)]" /><div className="h-8 w-32 rounded bg-[var(--surface-muted)]" /><div className="h-8 w-20 rounded bg-[var(--surface-muted)]" /></div>
      <Card className="mt-4 p-3"><div className="h-28 rounded bg-[var(--surface-muted)]" /></Card>
    </div>
  );
}

export default function Company() {
  const { activeCompanyId } = useCompany();
  const data = useQuery(api.companyManagement.overview, activeCompanyId ? { companyId: activeCompanyId } : "skip");
  const createBranch = useMutation(api.companyManagement.createBranch).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, branches: [...current.branches, { _id: crypto.randomUUID() as Id<"branches">, name: args.name }] });
  });
  const createDepartment = useMutation(api.companyManagement.createDepartment).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, departments: [...current.departments, { _id: crypto.randomUUID() as Id<"departments">, branchId: args.branchId, name: args.name }] });
  });
  const invite = useAction(api.companyManagement.inviteUser);
  const setRole = useMutation(api.companyManagement.setUserRole).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, users: current.users.map((user: any) => user.membership._id === args.membershipId ? { ...user, membership: { ...user.membership, role: args.role } } : user) });
  });
  const setAssignments = useMutation(api.companyManagement.setAssignments).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, users: current.users.map((user: any) => user.membership._id === args.membershipId ? { ...user, branchIds: args.branchIds, departmentIds: args.departmentIds } : user) });
  });
  const setScope = useMutation(api.companyManagement.setManagerScope).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, users: current.users.map((user: any) => user.membership._id === args.managerMembershipId ? { ...user, scope: { branchIds: args.branchIds, departmentIds: args.departmentIds, userMembershipIds: args.userMembershipIds } } : user) });
  });
  const setOverride = useMutation(api.companyManagement.setPermissionOverride).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, users: current.users.map((user: any) => user.membership._id === args.membershipId ? { ...user, overrides: args.effect === "inherit" ? user.overrides.filter((override: any) => override.capability !== args.capability) : [...user.overrides.filter((override: any) => override.capability !== args.capability), { _id: crypto.randomUUID(), capability: args.capability, effect: args.effect }] } : user) });
  });
  const [branch, setBranch] = useState("");
  const [dep, setDep] = useState("");
  const [email, setEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [pendingInvites, setPendingInvites] = useState<any[]>([]);

  if (!data) return <CompanySkeleton />;
  const firstBranch = data.branches[0];
  const firstDepartment = data.departments[0];
  const sampleCapability = "company:invite_users";

  return (
    <div className="app-page">
      <PageHeader
        title="Company management"
        description="Branches, departments, users, invitations, manager scopes, and permission overrides."
      />
      {inviteError && <p className="alert-error mb-4 rounded-md p-3 text-sm">{inviteError}</p>}
      <Tabs defaultValue="branches">
        <TabsList>
          <TabsTrigger value="branches">Branches</TabsTrigger>
          <TabsTrigger value="departments">Departments</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="invitations">Invitations</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
        </TabsList>

        <TabsContent value="branches" className="mt-4">
          <Card className="p-3">
            <div className="mb-3 flex gap-2"><Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="New branch" /><Button disabled={!branch.trim()} onClick={async () => { if (activeCompanyId && branch.trim()) { await createBranch({ companyId: activeCompanyId, name: branch }); setBranch(""); } }}>Create</Button></div>
            <div className="divide-y divide-[var(--hairline)]">{data.branches.map((item: any) => <div key={item._id} className="py-2 text-sm">{item.name}</div>)}</div>
          </Card>
        </TabsContent>

        <TabsContent value="departments" className="mt-4">
          <Card className="p-3">
            <div className="mb-3 flex gap-2"><Input value={dep} onChange={(event) => setDep(event.target.value)} placeholder="New department in first branch" /><Button disabled={!dep.trim() || !firstBranch} onClick={async () => { if (activeCompanyId && dep.trim() && firstBranch) { await createDepartment({ companyId: activeCompanyId, branchId: firstBranch._id, name: dep }); setDep(""); } }}>Create</Button></div>
            <div className="divide-y divide-[var(--hairline)]">{data.departments.map((item: any) => <div key={item._id} className="py-2 text-sm">{item.name}</div>)}</div>
            {!firstBranch && <p className="text-sm text-[var(--ink-muted)]">Create a branch before adding departments.</p>}
          </Card>
        </TabsContent>

        <TabsContent value="users" className="mt-4">
          <Card>
            <table className="notion-table">
              <thead><tr><th className="px-3">User</th><th>Role</th><th>Assignments</th><th>Actions</th></tr></thead>
              <tbody>{data.users.map((user: any) => <tr key={user.membership._id}>
                <td className="px-3 font-medium text-[var(--ink)]">{user.user.name || user.user.email}</td>
                <td><Badge>{user.membership.role}</Badge></td>
                <td className="text-[var(--ink-muted)]">{user.branchIds.length} branches · {user.departmentIds.length} departments</td>
                <td className="flex gap-2 py-2">
                  <Button size="sm" onClick={() => setRole({ companyId: activeCompanyId!, membershipId: user.membership._id, role: user.membership.role === "Admin" ? "Manager" : "Admin" })}>Toggle admin</Button>
                  <Button size="sm" onClick={() => setAssignments({ companyId: activeCompanyId!, membershipId: user.membership._id, branchIds: firstBranch ? [firstBranch._id] : [], departmentIds: firstDepartment ? [firstDepartment._id] : [] })}>Assign first scope</Button>
                </td>
              </tr>)}</tbody>
            </table>
          </Card>
        </TabsContent>

        <TabsContent value="invitations" className="mt-4">
          <Card className="p-3">
            <div className="mb-3 flex gap-2"><Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="employee@example.com" /><Button disabled={!email.trim()} onClick={async () => { const trimmedEmail = email.trim(); if (activeCompanyId && trimmedEmail) { const optimistic = { _id: crypto.randomUUID(), email: trimmedEmail, role: "Employee", status: "pending" }; setInviteError(null); setPendingInvites((current) => [optimistic, ...current]); try { await invite({ companyId: activeCompanyId, email: trimmedEmail, role: "Employee" }); setEmail(""); } catch (err) { setInviteError(err instanceof Error ? err.message : "Could not send invitation."); } finally { setPendingInvites((current) => current.filter((inviteRow) => inviteRow._id !== optimistic._id)); } } }}>Invite employee</Button></div>
            <div className="divide-y divide-[var(--hairline)]">{[...pendingInvites, ...data.invitations].map((item: any) => <div key={item._id} className="flex items-center gap-2 py-2 text-sm"><span className="font-medium text-[var(--ink)]">{item.email}</span><Badge>{item.status}</Badge><Badge>{item.role}</Badge></div>)}</div>
          </Card>
        </TabsContent>

        <TabsContent value="permissions" className="mt-4">
          <Card>
            <table className="notion-table">
              <thead><tr><th className="px-3">User</th><th>Manager scope</th><th>Sample override</th></tr></thead>
              <tbody>{data.users.map((user: any) => <tr key={user.membership._id}>
                <td className="px-3 font-medium text-[var(--ink)]">{user.user.name || user.user.email}</td>
                <td><Button size="sm" onClick={() => setScope({ companyId: activeCompanyId!, managerMembershipId: user.membership._id, branchIds: data.branches.map((item: any) => item._id), departmentIds: data.departments.map((item: any) => item._id), userMembershipIds: [] })}>Manage all branches/departments</Button></td>
                <td className="flex gap-2 py-2"><Button size="sm" onClick={() => setOverride({ companyId: activeCompanyId!, membershipId: user.membership._id, capability: sampleCapability, effect: "allow" })}>Allow invites</Button><Button size="sm" onClick={() => setOverride({ companyId: activeCompanyId!, membershipId: user.membership._id, capability: sampleCapability, effect: "inherit" })}>Inherit</Button></td>
              </tr>)}</tbody>
            </table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
