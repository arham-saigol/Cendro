"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useCompany } from "@/components/app/company-context";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, users: current.users.map((u: any) => u.membership._id === args.membershipId ? { ...u, membership: { ...u.membership, role: args.role } } : u) });
  });
  const setAssignments = useMutation(api.companyManagement.setAssignments).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, users: current.users.map((u: any) => u.membership._id === args.membershipId ? { ...u, branchIds: args.branchIds, departmentIds: args.departmentIds } : u) });
  });
  const setScope = useMutation(api.companyManagement.setManagerScope).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, users: current.users.map((u: any) => u.membership._id === args.managerMembershipId ? { ...u, scope: { branchIds: args.branchIds, departmentIds: args.departmentIds, userMembershipIds: args.userMembershipIds } } : u) });
  });
  const setOverride = useMutation(api.companyManagement.setPermissionOverride).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.companyManagement.overview, { companyId: args.companyId });
    if (current) store.setQuery(api.companyManagement.overview, { companyId: args.companyId }, { ...current, users: current.users.map((u: any) => u.membership._id === args.membershipId ? { ...u, overrides: args.effect === "inherit" ? u.overrides.filter((o: any) => o.capability !== args.capability) : [...u.overrides.filter((o: any) => o.capability !== args.capability), { _id: crypto.randomUUID(), capability: args.capability, effect: args.effect }] } : u) });
  });
  const [branch, setBranch] = useState("");
  const [dep, setDep] = useState("");
  const [email, setEmail] = useState("");
  const [pendingInvites, setPendingInvites] = useState<any[]>([]);

  if (!data) return <div className="p-8">Loading management…</div>;
  const firstBranch = data.branches[0];
  const firstDepartment = data.departments[0];
  const sampleCapability = "company:invite_users";

  return (
    <div className="p-8">
      <h1 className="text-[32px] font-bold">Company management</h1>
      <p className="mb-6 text-[var(--ink-muted)]">Branches, departments, users, invitations, manager scopes, and permission overrides.</p>
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
            <div className="mb-3 flex gap-2"><Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="New branch" /><Button onClick={async () => { if (activeCompanyId && branch) { await createBranch({ companyId: activeCompanyId, name: branch }); setBranch(""); } }}>Create</Button></div>
            {data.branches.map((b: any) => <div key={b._id} className="border-t py-2">{b.name}</div>)}
          </Card>
        </TabsContent>

        <TabsContent value="departments" className="mt-4">
          <Card className="p-3">
            <div className="mb-3 flex gap-2"><Input value={dep} onChange={(e) => setDep(e.target.value)} placeholder="New department in first branch" /><Button onClick={async () => { if (activeCompanyId && dep && firstBranch) { await createDepartment({ companyId: activeCompanyId, branchId: firstBranch._id, name: dep }); setDep(""); } }}>Create</Button></div>
            {data.departments.map((d: any) => <div key={d._id} className="border-t py-2">{d.name}</div>)}
            {!firstBranch && <p className="text-sm text-[var(--ink-muted)]">Create a branch before adding departments.</p>}
          </Card>
        </TabsContent>

        <TabsContent value="users" className="mt-4">
          <Card>
            <table className="notion-table">
              <thead><tr><th className="px-3">User</th><th>Role</th><th>Assignments</th><th>Actions</th></tr></thead>
              <tbody>{data.users.map((u: any) => <tr key={u.membership._id}>
                <td className="px-3">{u.user.name || u.user.email}</td>
                <td><Badge>{u.membership.role}</Badge></td>
                <td className="text-sm text-[var(--ink-muted)]">{u.branchIds.length} branches · {u.departmentIds.length} departments</td>
                <td className="flex gap-2 py-2">
                  <Button size="sm" onClick={() => setRole({ companyId: activeCompanyId!, membershipId: u.membership._id, role: u.membership.role === "Admin" ? "Manager" : "Admin" })}>Toggle admin</Button>
                  <Button size="sm" onClick={() => setAssignments({ companyId: activeCompanyId!, membershipId: u.membership._id, branchIds: firstBranch ? [firstBranch._id] : [], departmentIds: firstDepartment ? [firstDepartment._id] : [] })}>Assign first scope</Button>
                </td>
              </tr>)}</tbody>
            </table>
          </Card>
        </TabsContent>

        <TabsContent value="invitations" className="mt-4">
          <Card className="p-3">
            <div className="mb-3 flex gap-2"><Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="employee@example.com" /><Button onClick={async () => { if (activeCompanyId && email) { const optimistic = { _id: crypto.randomUUID(), email, role: "Employee", status: "pending" }; setPendingInvites((current) => [optimistic, ...current]); try { await invite({ companyId: activeCompanyId, email, role: "Employee" }); setEmail(""); } catch (err) { setPendingInvites((current) => current.filter((i) => i._id !== optimistic._id)); throw err; } finally { setPendingInvites((current) => current.filter((i) => i._id !== optimistic._id)); } } }}>Invite employee</Button></div>
            {[...pendingInvites, ...data.invitations].map((i: any) => <div key={i._id} className="border-t py-2">{i.email} <Badge>{i.status}</Badge> <Badge>{i.role}</Badge></div>)}
          </Card>
        </TabsContent>

        <TabsContent value="permissions" className="mt-4">
          <Card>
            <table className="notion-table">
              <thead><tr><th className="px-3">User</th><th>Manager scope</th><th>Sample override</th></tr></thead>
              <tbody>{data.users.map((u: any) => <tr key={u.membership._id}>
                <td className="px-3">{u.user.name || u.user.email}</td>
                <td><Button size="sm" onClick={() => setScope({ companyId: activeCompanyId!, managerMembershipId: u.membership._id, branchIds: data.branches.map((b: any) => b._id), departmentIds: data.departments.map((d: any) => d._id), userMembershipIds: [] })}>Manage all branches/departments</Button></td>
                <td className="flex gap-2 py-2"><Button size="sm" onClick={() => setOverride({ companyId: activeCompanyId!, membershipId: u.membership._id, capability: sampleCapability, effect: "allow" })}>Allow invites</Button><Button size="sm" onClick={() => setOverride({ companyId: activeCompanyId!, membershipId: u.membership._id, capability: sampleCapability, effect: "inherit" })}>Inherit</Button></td>
              </tr>)}</tbody>
            </table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
