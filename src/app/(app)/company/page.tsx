"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useAction, useMutation, useQuery } from "convex/react";
import { Building2, MailPlus, Settings2, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { PageHeader } from "@/components/app/page-header";
import { useCompany } from "@/components/app/company-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { capabilityGroups, capabilityLabels, defaultRoleCapabilities, roles, type Capability, type Role } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type Effect = "allow" | "deny" | "inherit";
type Override = { capability: string; effect: "allow" | "deny" };
type Scope = { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] };
type UserRow = { membership: { _id: Id<"companyMemberships">; role: Role; active: boolean }; user: { name: string; email: string }; branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; scope: Scope; overrides: Override[] };
type BranchRow = { _id: Id<"branches">; name: string };
type DepartmentRow = { _id: Id<"departments">; branchId: Id<"branches">; name: string };
type InvitationRow = { _id: Id<"invitations">; email: string; role: Role; status: string; permissionOverrides?: Override[] };
type Overview = { company?: { _id: Id<"companies">; name: string }; branches: BranchRow[]; departments: DepartmentRow[]; users: UserRow[]; invitations: InvitationRow[]; capabilities: Capability[] };

type PermissionDraft = {
  role: Role;
  branchIds: Id<"branches">[];
  departmentIds: Id<"departments">[];
  managedBranchIds: Id<"branches">[];
  managedDepartmentIds: Id<"departments">[];
  managedUserMembershipIds: Id<"companyMemberships">[];
  overrides: Record<Capability, Effect>;
};

const emptyOverrides = Object.fromEntries(capabilityGroups.flatMap((group) => group.capabilities.map((capability) => [capability, "inherit"]))) as Record<Capability, Effect>;

function CompanySkeleton() {
  return (
    <div className="app-page animate-pulse">
      <div className="h-8 w-72 rounded bg-[var(--surface-muted)]" />
      <div className="mb-6 mt-3 h-5 w-[520px] max-w-full rounded bg-[var(--surface-muted)]" />
      <div className="grid gap-3 md:grid-cols-[190px_1fr]"><div className="h-64 rounded bg-[var(--surface-muted)]" /><div className="h-64 rounded bg-[var(--surface-muted)]" /></div>
    </div>
  );
}

function SelectField<T extends string>({ value, onChange, children, disabled = false }: { value: T; onChange: (value: T) => void; children: React.ReactNode; disabled?: boolean }) {
  return <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)} className="h-8 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--focus-ring)] disabled:opacity-50">{children}</select>;
}

function draftFromUser(user: UserRow): PermissionDraft {
  return {
    role: user.membership.role,
    branchIds: user.branchIds,
    departmentIds: user.departmentIds,
    managedBranchIds: user.scope?.branchIds ?? [],
    managedDepartmentIds: user.scope?.departmentIds ?? [],
    managedUserMembershipIds: user.scope?.userMembershipIds ?? [],
    overrides: { ...emptyOverrides, ...Object.fromEntries(user.overrides.map((override) => [override.capability, override.effect])) },
  };
}

function effectiveCapabilities(role: Role, overrides: Record<Capability, Effect>) {
  const effective = new Set<Capability>(defaultRoleCapabilities[role]);
  for (const capability of Object.keys(overrides) as Capability[]) {
    if (overrides[capability] === "allow") effective.add(capability);
    if (overrides[capability] === "deny") effective.delete(capability);
  }
  return effective;
}

function MultiSelectList<T extends string>({ title, empty, options, selected, onChange }: { title: string; empty: string; options: { id: T; label: string; helper?: string }[]; selected: T[]; onChange: (ids: T[]) => void }) {
  const selectedSet = new Set(selected);
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-[var(--ink-muted)]">{title}</div>
      <div className="max-h-32 overflow-auto rounded-md border border-[var(--hairline)] p-1">
        {options.length === 0 ? <div className="px-2 py-1.5 text-xs text-[var(--ink-muted)]">{empty}</div> : options.map((option) => {
          const toggle = () => onChange(selectedSet.has(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id]);
          return (
            <div key={option.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--surface-hover)]">
              <Checkbox checked={selectedSet.has(option.id)} aria-label={option.label} onCheckedChange={toggle} />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={toggle}>
                <span className="block truncate text-sm text-[var(--ink)]">{option.label}</span>
                {option.helper && <span className="block truncate text-[11px] text-[var(--ink-muted)]">{option.helper}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PermissionGroups({ role, overrides, onChange }: { role: Role; overrides: Record<Capability, Effect>; onChange: (next: Record<Capability, Effect>) => void }) {
  const effective = useMemo(() => effectiveCapabilities(role, overrides), [role, overrides]);
  return (
    <div className="space-y-4">
      {capabilityGroups.map((group) => (
        <section key={group.title}>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">{group.title}</div>
          <div className="grid gap-1 lg:grid-cols-2">
            {group.capabilities.map((capability) => {
              const inherited = defaultRoleCapabilities[role].includes(capability);
              const checked = effective.has(capability);
              const effect = overrides[capability];
              const toggle = () => {
                const nextChecked = !checked;
                const nextEffect: Effect = nextChecked === inherited ? "inherit" : nextChecked ? "allow" : "deny";
                onChange({ ...overrides, [capability]: nextEffect });
              };
              return (
                <div key={capability} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hover)]">
                  <Checkbox checked={checked} aria-label={capabilityLabels[capability]} onCheckedChange={toggle} />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={toggle}>
                    <span className="block text-sm text-[var(--ink)]">{capabilityLabels[capability]}</span>
                    <span className="text-[11px] text-[var(--ink-muted)]">{effect === "inherit" ? inherited ? "Inherited from role" : "Off by default" : effect === "allow" ? "Manually allowed" : "Manually denied"}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function InviteDialog({ open, onOpenChange, data, onInvite }: { open: boolean; onOpenChange: (open: boolean) => void; data: Overview; onInvite: (args: { email: string; role: Role; branchId: Id<"branches"> | ""; departmentId: Id<"departments"> | "" }) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("Employee");
  const [branchId, setBranchId] = useState<Id<"branches"> | "">("");
  const [departmentId, setDepartmentId] = useState<Id<"departments"> | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setEmail(""); setRole("Employee"); setBranchId(""); setDepartmentId(""); setError(null); }
  }, [open]);

  async function submit() {
    if (!email.trim()) { setError("Email is required."); return; }
    setSaving(true);
    setError(null);
    try {
      await onInvite({ email: email.trim(), role, branchId, departmentId });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send invitation.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
          <div className="flex items-start justify-between border-b border-[var(--hairline)] px-4 py-3">
            <div><Dialog.Title className="text-[15px] font-semibold text-[var(--ink)]">Invite member</Dialog.Title><Dialog.Description className="text-xs text-[var(--ink-muted)]">Set their starting role and team placement.</Dialog.Description></div>
            <Dialog.Close asChild><button type="button" className="task-icon-btn" aria-label="Close"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <div className="space-y-3 p-4">
            <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="member@example.com" />
            <div className="grid gap-2 sm:grid-cols-2">
              <SelectField value={role} onChange={setRole}>{roles.map((item) => <option key={item} value={item}>{item}</option>)}</SelectField>
              <SelectField value={branchId} onChange={setBranchId}><option value="">No branch</option>{data.branches.map((branch) => <option key={branch._id} value={branch._id}>{branch.name}</option>)}</SelectField>
              <SelectField value={departmentId} onChange={setDepartmentId}><option value="">No department</option>{data.departments.map((department) => <option key={department._id} value={department._id}>{department.name}</option>)}</SelectField>
            </div>
            {error && <p className="alert-error rounded-md px-3 py-2 text-sm">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--hairline)] px-4 py-3">
            <Dialog.Close asChild><Button>Cancel</Button></Dialog.Close>
            <Button variant="primary" onClick={submit} disabled={saving}>{saving ? "Sending…" : "Send invite"}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PermissionsDialog({ open, onOpenChange, data, user, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; data: Overview; user?: UserRow; onSave: (user: UserRow, draft: PermissionDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<PermissionDraft>(() => user ? draftFromUser(user) : { role: "Employee", branchIds: [], departmentIds: [], managedBranchIds: [], managedDepartmentIds: [], managedUserMembershipIds: [], overrides: { ...emptyOverrides } });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && user) { setDraft(draftFromUser(user)); setError(null); }
  }, [open, user]);

  if (!user) return null;
  const currentUser = user;

  const branches = data.branches.map((branch) => ({ id: branch._id, label: branch.name }));
  const departments = data.departments.map((department) => ({ id: department._id, label: department.name, helper: data.branches.find((branch) => branch._id === department.branchId)?.name }));
  const people = data.users.filter((row) => row.membership._id !== user.membership._id).map((row) => ({ id: row.membership._id, label: row.user.name || row.user.email, helper: row.membership.role }));
  const overrideCount = Object.values(draft.overrides).filter((effect) => effect !== "inherit").length;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await onSave(currentUser, draft);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save permissions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(900px,94dvh)] w-[min(920px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
          <div className="flex items-start justify-between border-b border-[var(--hairline)] px-4 py-3">
            <div><Dialog.Title className="text-[15px] font-semibold text-[var(--ink)]">Permissions for {user.user.name || user.user.email}</Dialog.Title><Dialog.Description className="text-xs text-[var(--ink-muted)]">Role defaults are inherited first. Toggle individual permissions only when this user needs an exception.</Dialog.Description></div>
            <Dialog.Close asChild><button type="button" className="task-icon-btn" aria-label="Close"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <div className="grid gap-4 xl:grid-cols-[300px_1fr]">
              <aside className="space-y-4">
                <Card className="p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Role</div>
                  <SelectField value={draft.role} onChange={(role) => setDraft({ ...draft, role })}>{roles.map((item) => <option key={item} value={item}>{item}</option>)}</SelectField>
                </Card>
                <Card className="space-y-3 p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Member placement</div>
                  <MultiSelectList title="Branches" empty="No branches" options={branches} selected={draft.branchIds} onChange={(branchIds) => setDraft({ ...draft, branchIds })} />
                  <MultiSelectList title="Departments" empty="No departments" options={departments} selected={draft.departmentIds} onChange={(departmentIds) => setDraft({ ...draft, departmentIds })} />
                </Card>
                <Card className="space-y-3 p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Managed scope</div>
                  <MultiSelectList title="People under this user" empty="No other people" options={people} selected={draft.managedUserMembershipIds} onChange={(managedUserMembershipIds) => setDraft({ ...draft, managedUserMembershipIds })} />
                  <MultiSelectList title="Branches under this user" empty="No branches" options={branches} selected={draft.managedBranchIds} onChange={(managedBranchIds) => setDraft({ ...draft, managedBranchIds })} />
                  <MultiSelectList title="Departments under this user" empty="No departments" options={departments} selected={draft.managedDepartmentIds} onChange={(managedDepartmentIds) => setDraft({ ...draft, managedDepartmentIds })} />
                </Card>
              </aside>
              <Card className="p-3">
                <PermissionGroups role={draft.role} overrides={draft.overrides} onChange={(overrides) => setDraft({ ...draft, overrides })} />
              </Card>
            </div>
          </div>
          {error && <p className="alert-error mx-4 mb-3 rounded-md px-3 py-2 text-sm">{error}</p>}
          <div className="flex items-center justify-between border-t border-[var(--hairline)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--ink-muted)]">
            <span>{overrideCount} manual override{overrideCount === 1 ? "" : "s"}</span>
            <div className="flex gap-2"><Dialog.Close asChild><Button>Cancel</Button></Dialog.Close><Button variant="primary" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save permissions"}</Button></div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function Company() {
  const { activeCompanyId, active } = useCompany();
  const data = useQuery(api.companyManagement.overview, activeCompanyId ? { companyId: activeCompanyId } : "skip") as Overview | undefined;
  const updateCompanyName = useMutation(api.companyManagement.updateCompanyName);
  const createBranch = useMutation(api.companyManagement.createBranch);
  const createDepartment = useMutation(api.companyManagement.createDepartment);
  const invite = useAction(api.companyManagement.inviteUser);
  const setRole = useMutation(api.companyManagement.setUserRole);
  const setAssignments = useMutation(api.companyManagement.setAssignments);
  const setScope = useMutation(api.companyManagement.setManagerScope);
  const setOverride = useMutation(api.companyManagement.setPermissionOverride);

  const [companyName, setCompanyName] = useState("");
  const [branch, setBranch] = useState("");
  const [department, setDepartment] = useState("");
  const [departmentBranchId, setDepartmentBranchId] = useState<Id<"branches"> | "">("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [permissionsUser, setPermissionsUser] = useState<UserRow | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setCompanyName(data.company?.name ?? active?.company.name ?? "");
      setDepartmentBranchId((current) => current || data.branches[0]?._id || "");
    }
  }, [active?.company.name, data]);

  if (!data) return <CompanySkeleton />;
  const currentCompany = data.company ?? active?.company;

  async function run(action: () => Promise<unknown>, message = "Something went wrong.") {
    setError(null);
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : message); }
  }

  async function inviteMember(args: { email: string; role: Role; branchId: Id<"branches"> | ""; departmentId: Id<"departments"> | "" }) {
    if (!activeCompanyId) return;
    await invite({
      companyId: activeCompanyId,
      email: args.email,
      role: args.role,
      branchIds: args.branchId ? [args.branchId] : [],
      departmentIds: args.departmentId ? [args.departmentId] : [],
      managedBranchIds: [],
      managedDepartmentIds: [],
      managedUserMembershipIds: [],
      permissionOverrides: [],
    });
  }

  async function savePermissions(user: UserRow, draft: PermissionDraft) {
    if (!activeCompanyId) return;
    await setRole({ companyId: activeCompanyId, membershipId: user.membership._id, role: draft.role });
    await setAssignments({ companyId: activeCompanyId, membershipId: user.membership._id, branchIds: draft.branchIds, departmentIds: draft.departmentIds });
    await setScope({ companyId: activeCompanyId, managerMembershipId: user.membership._id, branchIds: draft.managedBranchIds, departmentIds: draft.managedDepartmentIds, userMembershipIds: draft.managedUserMembershipIds });
    const initial = draftFromUser(user).overrides;
    for (const capability of data?.capabilities ?? []) {
      if (initial[capability] !== draft.overrides[capability]) await setOverride({ companyId: activeCompanyId, membershipId: user.membership._id, capability, effect: draft.overrides[capability] });
    }
  }

  return (
    <div className="app-page">
      <PageHeader title="Company management" description="Settings, branches, people, scopes, and permission overrides." />
      {error && <p className="alert-error mb-4 rounded-md p-3 text-sm">{error}</p>}

      <Tabs defaultValue="general" orientation="vertical" className="grid gap-4 md:grid-cols-[190px_1fr]">
        <TabsList className="flex flex-row overflow-x-auto md:flex-col md:items-stretch md:overflow-visible">
          {[{ value: "general", label: "General" }, { value: "structure", label: "Branches & departments" }, { value: "people", label: "Users & invitations" }, { value: "permissions", label: "Permissions" }].map((tab) => <TabsTrigger key={tab.value} value={tab.value} className="justify-start">{tab.label}</TabsTrigger>)}
        </TabsList>

        <div className="min-w-0">
          <TabsContent value="general">
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--ink)]"><Building2 className="h-4 w-4 text-[var(--ink-muted)]" /> Company settings</div>
              <div className="flex max-w-xl gap-2"><Input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="Company name" /><Button onClick={() => activeCompanyId && run(async () => updateCompanyName({ companyId: activeCompanyId, name: companyName }))} disabled={!companyName.trim() || companyName === currentCompany?.name}>Save</Button></div>
            </Card>
          </TabsContent>

          <TabsContent value="structure">
            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="p-4">
                <div className="mb-3 text-sm font-semibold text-[var(--ink)]">Branches</div>
                <div className="mb-3 flex gap-2"><Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="New branch" /><Button disabled={!branch.trim()} onClick={() => activeCompanyId && run(async () => { await createBranch({ companyId: activeCompanyId, name: branch }); setBranch(""); })}>Create</Button></div>
                <div className="divide-y divide-[var(--hairline)]">{data.branches.map((item) => <div key={item._id} className="py-2 text-sm text-[var(--ink)]">{item.name}</div>)}</div>
              </Card>
              <Card className="p-4">
                <div className="mb-3 text-sm font-semibold text-[var(--ink)]">Departments</div>
                <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_160px_auto]"><Input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="New department" /><SelectField value={departmentBranchId} onChange={setDepartmentBranchId} disabled={!data.branches.length}><option value="">Select branch</option>{data.branches.map((item) => <option key={item._id} value={item._id}>{item.name}</option>)}</SelectField><Button disabled={!department.trim() || !departmentBranchId} onClick={() => activeCompanyId && departmentBranchId && run(async () => { await createDepartment({ companyId: activeCompanyId, branchId: departmentBranchId, name: department }); setDepartment(""); })}>Create</Button></div>
                <div className="divide-y divide-[var(--hairline)]">{data.departments.map((item) => <div key={item._id} className="flex items-center justify-between gap-2 py-2 text-sm"><span className="text-[var(--ink)]">{item.name}</span><span className="text-xs text-[var(--ink-muted)]">{data.branches.find((branch) => branch._id === item.branchId)?.name}</span></div>)}</div>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="people">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-[var(--hairline)] px-3 py-2"><div className="text-sm font-semibold text-[var(--ink)]">Members</div><Button size="sm" variant="primary" onClick={() => setInviteOpen(true)}><MailPlus className="mr-1.5 h-3.5 w-3.5" /> Invite</Button></div>
              <div className="divide-y divide-[var(--hairline)]">{data.users.map((user) => <div key={user.membership._id} className="grid gap-2 px-3 py-2.5 text-sm md:grid-cols-[1fr_120px_180px_auto] md:items-center"><span><span className="block font-medium text-[var(--ink)]">{user.user.name || user.user.email}</span><span className="text-xs text-[var(--ink-muted)]">{user.user.email}</span></span><Badge className="w-fit">{user.membership.role}</Badge><span className="text-xs text-[var(--ink-muted)]">{user.branchIds.length} branches · {user.departmentIds.length} departments</span><Button size="sm" onClick={() => setPermissionsUser(user)}><Settings2 className="mr-1.5 h-3.5 w-3.5" /> Permissions</Button></div>)}</div>
            </Card>
            <Card className="mt-3 p-3">
              <div className="mb-2 text-sm font-semibold text-[var(--ink)]">Pending invitations</div>
              <div className="divide-y divide-[var(--hairline)]">{data.invitations.length === 0 ? <div className="py-2 text-sm text-[var(--ink-muted)]">No pending invitations.</div> : data.invitations.map((item) => <div key={item._id} className="flex flex-wrap items-center gap-2 py-2 text-sm"><span className="font-medium text-[var(--ink)]">{item.email}</span><Badge>{item.status}</Badge><Badge>{item.role}</Badge></div>)}</div>
            </Card>
          </TabsContent>

          <TabsContent value="permissions">
            <Card className="overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-2 text-sm font-semibold text-[var(--ink)]"><ShieldCheck className="h-4 w-4 text-[var(--ink-muted)]" /> Permission profiles</div>
              <div className="divide-y divide-[var(--hairline)]">{data.users.map((user) => {
                const overrideMap = { ...emptyOverrides, ...Object.fromEntries(user.overrides.map((override) => [override.capability, override.effect])) } as Record<Capability, Effect>;
                const effective = effectiveCapabilities(user.membership.role, overrideMap);
                const dashboardEnabled = effective.has("analytics:view:self") || effective.has("analytics:view:managed_scope") || effective.has("analytics:view:company");
                const managedCount = (user.scope?.branchIds.length ?? 0) + (user.scope?.departmentIds.length ?? 0) + (user.scope?.userMembershipIds.length ?? 0);
                return <div key={user.membership._id} className="grid gap-2 px-3 py-2.5 text-sm md:grid-cols-[1fr_120px_150px_120px_auto] md:items-center"><span className="font-medium text-[var(--ink)]">{user.user.name || user.user.email}</span><Badge className="w-fit">{user.membership.role}</Badge><span className={cn("text-xs", dashboardEnabled ? "text-[var(--ink-muted)]" : "text-red-600")}>{dashboardEnabled ? "Dashboard on" : "Dashboard off"}</span><span className="text-xs text-[var(--ink-muted)]">{managedCount} scopes</span><Button size="sm" onClick={() => setPermissionsUser(user)}>Configure</Button></div>;
              })}</div>
            </Card>
          </TabsContent>
        </div>
      </Tabs>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} data={data} onInvite={inviteMember} />
      <PermissionsDialog open={Boolean(permissionsUser)} onOpenChange={(open) => !open && setPermissionsUser(undefined)} data={data} user={permissionsUser} onSave={savePermissions} />
    </div>
  );
}
