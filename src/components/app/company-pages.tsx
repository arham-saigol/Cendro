"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Layers,
  LucideIcon,
  MailPlus,
  Network,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import type { DragEndEvent } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "@/components/app/company-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn, formatDate, initials } from "@/lib/utils";
import { capabilityGroups, capabilityLabels, defaultRoleCapabilities, roles, type Capability, type Role } from "@/lib/permissions";

/* ============================================================== */
/*  Types                                                          */
/* ============================================================== */

type Effect = "allow" | "deny" | "inherit";
type Override = { capability: string; effect: "allow" | "deny" };
type MembershipCore = { _id: Id<"companyMemberships">; role: Role; active: boolean; createdAt: number };
type Scope = { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] };
type UserRow = {
  membership: MembershipCore;
  user: { name: string; email: string };
  branchIds: Id<"branches">[];
  departmentIds: Id<"departments">[];
  scope: Scope;
  overrides: Override[];
};
type BranchRow = { _id: Id<"branches">; name: string; order?: number };
type DepartmentRow = { _id: Id<"departments">; branchId: Id<"branches">; name: string; order?: number };
type InvitationRow = {
  _id: Id<"invitations">;
  email: string;
  role: Role;
  status: string;
  createdAt: number;
  branchIds: Id<"branches">[];
  departmentIds: Id<"departments">[];
  permissionOverrides?: Override[];
};
type Overview = {
  company?: { _id: Id<"companies">; name: string };
  currentMembership: MembershipCore;
  branches: BranchRow[];
  departments: DepartmentRow[];
  users: UserRow[];
  invitations: InvitationRow[];
  capabilities: Capability[];
};
type TabValue = "general" | "structure" | "people" | "permissions";
type PermissionDraft = {
  role: Role;
  branchIds: Id<"branches">[];
  departmentIds: Id<"departments">[];
  managedBranchIds: Id<"branches">[];
  managedDepartmentIds: Id<"departments">[];
  managedUserMembershipIds: Id<"companyMemberships">[];
  overrides: Record<Capability, Effect>;
};

const emptyOverrides = Object.fromEntries(
  capabilityGroups.flatMap((group) => group.capabilities.map((capability) => [capability, "inherit"])),
) as Record<Capability, Effect>;

const roleTone: Record<Role, "blue" | "green" | "neutral"> = {
  Admin: "blue",
  Manager: "green",
  Employee: "neutral",
};

const TABS: { value: TabValue; label: string; icon: LucideIcon; getCount?: (data: Overview) => number }[] = [
  { value: "general", label: "General", icon: Settings },
  { value: "structure", label: "Structure", icon: Network, getCount: (data) => data.branches.length + data.departments.length },
  { value: "people", label: "People", icon: Users, getCount: (data) => data.users.length + data.invitations.length },
  { value: "permissions", label: "Permissions", icon: ShieldCheck, getCount: (data) => data.users.reduce((total, user) => total + user.overrides.length, 0) },
];

const TAB_COPY: Record<TabValue, { title: string; description: string }> = {
  general: {
    title: "General",
    description: "Keep the workspace name and identity tidy.",
  },
  structure: {
    title: "Structure",
    description: "Define the branches and departments that shape ownership across the company.",
  },
  people: {
    title: "People",
    description: "Manage members, pending invitations, team placement, and access level.",
  },
  permissions: {
    title: "Permissions",
    description: "Review role defaults and configure deliberate exceptions only where needed.",
  },
};

/* ============================================================== */
/*  Helpers                                                        */
/* ============================================================== */

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

/* ============================================================== */
/*  Shared UI                                                      */
/* ============================================================== */

function MemberAvatar({ name, email, size = "sm" }: { name: string; email: string; size?: "sm" | "md" }) {
  const dim = size === "md" ? "h-7 w-7 text-[11px]" : "h-6 w-6 text-[10px]";
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-[linear-gradient(135deg,var(--surface-hover),var(--surface-pressed))] font-semibold text-[var(--ink-secondary)]",
        dim,
      )}
      title={name || email}
    >
      {initials(name, email)}
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  message,
  action,
}: {
  icon: LucideIcon;
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="task-empty">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]">
        <Icon className="h-5 w-5" />
      </span>
      <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">{title}</div>
      {message && <p className="mt-1 max-w-[300px] text-[13px] text-[var(--ink-muted)]">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function SelectField<T extends string>({
  value,
  onChange,
  children,
  disabled = false,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className={cn(
        "h-8 w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-[13px] text-[var(--ink)] outline-none transition-[border-color,box-shadow] duration-150 hover:border-[var(--hairline-strong)] focus:border-[var(--focus-ring)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus-ring)_14%,transparent)] disabled:opacity-50",
        className,
      )}
    >
      {children}
    </select>
  );
}

function FilterSubmenu<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="task-menu-item">
        <span className="flex-1">{label}</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={7} alignOffset={-5} className="task-menu min-w-48">
          {options.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => onChange(option.value)} className="task-menu-item">
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {value === option.value && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function CompanyFilterMenu({
  roleFilter,
  activeCount,
  onRoleChange,
}: {
  roleFilter: Role | "all";
  activeCount: number;
  onRoleChange: (value: Role | "all") => void;
}) {
  const roleOptions: { value: Role | "all"; label: string }[] = [{ value: "all", label: "All roles" }, ...roles.map((role) => ({ value: role, label: role }))];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-toolbar-icon" data-active={activeCount > 0} aria-label="Filter people">
          <SlidersHorizontal className="h-4 w-4" />
          {activeCount > 0 && <span className="task-toolbar-badge">{activeCount}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="task-menu min-w-48" aria-label="People filters">
          <FilterSubmenu label="Role" value={roleFilter} options={roleOptions} onChange={onRoleChange} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/* ============================================================== */
/*  General tab                                                    */
/* ============================================================== */

function CompanyContentHeader({ tab }: { tab: TabValue }) {
  const copy = TAB_COPY[tab];

  return (
    <header className="company-content-header">
      <div className="min-w-0">
        <h1 className="company-content-title">{copy.title}</h1>
        <p className="company-content-description">{copy.description}</p>
      </div>
    </header>
  );
}

function GeneralTab({
  data,
  companyName,
  setCompanyName,
  nameDirty,
  savingName,
  canManageSettings,
  onSaveName,
}: {
  data: Overview;
  companyName: string;
  setCompanyName: (value: string) => void;
  nameDirty: boolean;
  savingName: boolean;
  canManageSettings: boolean;
  onSaveName: () => Promise<void> | void;
}) {
  return (
    <div className="company-tab-body">
      <section className="company-settings-section">
        <h2 className="company-tab-section-title">Workspace settings</h2>
        <div className="company-settings-list">
          <div className="company-settings-row">
            <div className="min-w-0">
              <div className="company-settings-label">Company name</div>
              <p className="company-settings-help">Shown in the sidebar, invitations, and company-level records.</p>
            </div>
            <div className="company-settings-control">
              <div className="company-name-field">
                <Input
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder="Company name"
                  disabled={!canManageSettings}
                  aria-label="Company name"
                  className="company-name-input w-auto"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && nameDirty && canManageSettings) void onSaveName();
                  }}
                />
                {canManageSettings && nameDirty && (
                  <button
                    type="button"
                    className="company-name-save"
                    disabled={savingName}
                    onClick={() => void onSaveName()}
                  >
                    {savingName ? "Saving..." : "Save"}
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="company-settings-row">
            <div className="min-w-0">
              <div className="company-settings-label">Icon</div>
              <p className="company-settings-help">A simple workspace mark used in management views.</p>
            </div>
            <div className="company-settings-control justify-start sm:justify-end">
              <div className="company-logo" aria-hidden="true">{initials(companyName || data.company?.name || "Company")}</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ============================================================== */
/*  Structure tab                                                  */
/* ============================================================== */

const BRANCH_GROUP = "branches";
const BRANCH_TYPE = "branch";
const DEPT_TYPE = "department";

type BranchSortableData = { kind: typeof BRANCH_TYPE };
type DepartmentSortableData = { kind: typeof DEPT_TYPE };
type ZoneData = { kind: "branchZone"; branchId: Id<"branches"> };

function arrayMove<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function StructureBranchRow({
  branch,
  index,
  depCount,
  memberCount,
  isCollapsed,
  canDrag,
  onToggleCollapse,
  onDelete,
  children,
}: {
  branch: BranchRow;
  index: number;
  depCount: number;
  memberCount: number;
  isCollapsed: boolean;
  canDrag: boolean;
  onToggleCollapse: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  const { ref, targetRef, handleRef, isDragging } = useSortable<BranchSortableData>({
    id: branch._id,
    index,
    group: BRANCH_GROUP,
    type: BRANCH_TYPE,
    accept: BRANCH_TYPE,
    disabled: !canDrag,
    data: { kind: BRANCH_TYPE },
  });
  return (
    <div ref={ref} className={cn("structure-branch", isDragging && "is-dragging")}>
      <div
        ref={targetRef}
        className={cn("structure-row structure-row-branch", isDragging && "is-dragging")}
      >
        {canDrag && (
          <button type="button" ref={handleRef} className="structure-grip" aria-label="Drag branch">
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className="structure-chevron"
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? "Expand branch" : "Collapse branch"}
        >
          {depCount > 0 ? (isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />) : <span className="h-3.5 w-3.5" />}
        </button>
        <Building2 className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">{branch.name}</span>
        <span className="structure-count">{depCount} dept{depCount === 1 ? "" : "s"} · {memberCount} member{memberCount === 1 ? "" : "s"}</span>
        {canDrag && (
          <button
            type="button"
            className="task-icon-btn"
            onClick={onDelete}
            aria-label={`Delete branch ${branch.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function StructureDepartmentRow({
  dep,
  index,
  branchId,
  memberCount,
  canDrag,
  onDelete,
}: {
  dep: DepartmentRow;
  index: number;
  branchId: Id<"branches">;
  memberCount: number;
  canDrag: boolean;
  onDelete: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable<DepartmentSortableData>({
    id: dep._id,
    index,
    group: branchId,
    type: DEPT_TYPE,
    accept: DEPT_TYPE,
    disabled: !canDrag,
    data: { kind: DEPT_TYPE },
  });
  return (
    <div
      ref={ref}
      className={cn("structure-row structure-row-department", isDragging && "is-dragging")}
    >
      {canDrag && (
        <button type="button" ref={handleRef} className="structure-grip" aria-label="Drag department">
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      <span className="structure-chevron-placeholder" aria-hidden />
      <Layers className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
      <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{dep.name}</span>
      <span className="structure-count">{memberCount} member{memberCount === 1 ? "" : "s"}</span>
      {canDrag && (
        <button
          type="button"
          className="task-icon-btn"
          onClick={onDelete}
          aria-label={`Delete department ${dep.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function StructureBranchDropZone({ branchId }: { branchId: Id<"branches"> }) {
  const { ref, isDropTarget } = useDroppable<ZoneData>({
    id: `zone-${branchId}`,
    type: "branchZone",
    accept: DEPT_TYPE,
    data: { kind: "branchZone", branchId },
  });
  return <div ref={ref} className={cn("structure-dropzone", isDropTarget && "is-drop-target")} />;
}

function StructureTab({
  data,
  canManageBranches,
  canManageDepartments,
  onCreateBranch,
  onCreateDepartment,
  onDeleteBranch,
  onDeleteDepartment,
  onReorderBranches,
  onMoveDepartment,
}: {
  data: Overview;
  canManageBranches: boolean;
  canManageDepartments: boolean;
  onCreateBranch: (name: string) => void;
  onCreateDepartment: (branchId: Id<"branches">, name: string) => void;
  onDeleteBranch: (id: Id<"branches">) => void;
  onDeleteDepartment: (id: Id<"departments">) => void;
  onReorderBranches: (orderedBranchIds: Id<"branches">[]) => void;
  onMoveDepartment: (departmentId: Id<"departments">, toBranchId: Id<"branches">, orderedDepartmentIds: Id<"departments">[]) => void;
}) {
  const [branches, setBranches] = useState<BranchRow[]>(data.branches);
  const [departments, setDepartments] = useState<DepartmentRow[]>(data.departments);
  const [collapsed, setCollapsed] = useState<Set<Id<"branches">>>(new Set());
  const [newBranchName, setNewBranchName] = useState("");
  const [newDeptByBranch, setNewDeptByBranch] = useState<Record<string, string>>({});
  const isDragging = useRef(false);

  // Re-seed from real-time data when no drag is in progress.
  useEffect(() => {
    if (isDragging.current) return;
    setBranches(data.branches);
    setDepartments(data.departments);
  }, [data.branches, data.departments]);

  const departmentsByBranch = useMemo(() => {
    const map = new Map<Id<"branches">, DepartmentRow[]>();
    for (const branch of branches) map.set(branch._id, []);
    const sorted = [...departments].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a._id.localeCompare(b._id));
    for (const dep of sorted) {
      const list = map.get(dep.branchId);
      if (list) list.push(dep);
    }
    return map;
  }, [branches, departments]);

  const memberCountForBranch = (branchId: Id<"branches">) =>
    data.users.filter((u) => u.branchIds.includes(branchId)).length;
  const memberCountForDepartment = (departmentId: Id<"departments">) =>
    data.users.filter((u) => u.departmentIds.includes(departmentId)).length;

  function toggleCollapse(branchId: Id<"branches">) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(branchId)) next.delete(branchId);
      else next.add(branchId);
      return next;
    });
  }

  function expand(branchId: Id<"branches">) {
    setCollapsed((prev) => {
      if (!prev.has(branchId)) return prev;
      const next = new Set(prev);
      next.delete(branchId);
      return next;
    });
  }

  const newDeptName = (branchId: Id<"branches">) => newDeptByBranch[branchId] ?? "";
  const setNewDeptName = (branchId: Id<"branches">, value: string) =>
    setNewDeptByBranch((prev) => ({ ...prev, [branchId]: value }));

  function commitDepartmentToBranch(deptId: Id<"departments">, toBranchId: Id<"branches">) {
    const dragged = departments.find((d) => d._id === deptId);
    if (!dragged) return;
    const without = departments.filter((d) => d._id !== deptId);
    const toList = without.filter((d) => d.branchId === toBranchId);
    toList.push({ ...dragged, branchId: toBranchId });
    const reindexed = toList.map((d, i) => ({ ...d, branchId: toBranchId, order: i }));
    const others = without.filter((d) => d.branchId !== toBranchId);
    setDepartments([...others, ...reindexed]);
    onMoveDepartment(deptId, toBranchId, reindexed.map((d) => d._id));
    expand(toBranchId);
  }

  function commitDepartmentSort(
    deptId: Id<"departments">,
    fromBranch: Id<"branches">,
    toBranch: Id<"branches">,
    toIndex: number,
  ) {
    const dragged = departments.find((d) => d._id === deptId);
    if (!dragged) return;
    const without = departments.filter((d) => d._id !== deptId);
    const toList = without.filter((d) => d.branchId === toBranch);
    toList.splice(toIndex, 0, { ...dragged, branchId: toBranch });
    const reindexed = toList.map((d, i) => ({ ...d, branchId: toBranch, order: i }));
    const others = without.filter((d) => d.branchId !== toBranch);
    setDepartments([...others, ...reindexed]);
    onMoveDepartment(deptId, toBranch, reindexed.map((d) => d._id));
    if (fromBranch !== toBranch) expand(toBranch);
  }

  function handleDragEnd(event: DragEndEvent) {
    isDragging.current = false;
    if (event.canceled) return;
    const { source, target } = event.operation;
    if (!source) return;

    // Dropped onto a branch drop zone → append only departments to that branch.
    if (target?.data?.kind === "branchZone") {
      if (source.data?.kind !== DEPT_TYPE) return;
      commitDepartmentToBranch(source.id as Id<"departments">, target.data.branchId as Id<"branches">);
      return;
    }

    if (!isSortable(source)) return;

    // Branch reorder (top-level group).
    if (source.data?.kind === BRANCH_TYPE) {
      if (source.initialGroup !== BRANCH_GROUP || source.initialIndex === source.index) return;
      const reordered = arrayMove(branches, source.initialIndex, source.index).map((b, i) => ({ ...b, order: i }));
      setBranches(reordered);
      onReorderBranches(reordered.map((b) => b._id));
      return;
    }

    // Department move (within or across branches).
    if (source.data?.kind !== DEPT_TYPE) return;
    const fromBranch = source.initialGroup as Id<"branches">;
    const toBranch = source.group as Id<"branches">;
    if (!fromBranch || !toBranch) return;
    commitDepartmentSort(source.id as Id<"departments">, fromBranch, toBranch, source.index);
  }

  return (
    <div className="company-tab-body">
      <div className="company-tab-section">
        <DragDropProvider
          onDragStart={() => { isDragging.current = true; }}
          onDragEnd={handleDragEnd}
        >
          <div className="structure-tree">
            {branches.length === 0 && (
              <EmptyState
                icon={Network}
                title="No branches yet"
                message="Create a branch to start organizing your workspace into teams."
                action={
                  canManageBranches ? (
                    <div className="structure-add-row structure-add-row-inline">
                      <Plus className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                      <input
                        autoFocus
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        placeholder="Add a branch…"
                        className="structure-add-input"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newBranchName.trim()) {
                            onCreateBranch(newBranchName.trim());
                            setNewBranchName("");
                          }
                        }}
                      />
                    </div>
                  ) : undefined
                }
              />
            )}

            {branches.map((branch, branchIndex) => {
              const isCollapsed = collapsed.has(branch._id);
              const deps = departmentsByBranch.get(branch._id) ?? [];
              const depCount = deps.length;
              const memberCount = memberCountForBranch(branch._id);
              return (
                <StructureBranchRow
                  key={branch._id}
                  branch={branch}
                  index={branchIndex}
                  depCount={depCount}
                  memberCount={memberCount}
                  isCollapsed={isCollapsed}
                  canDrag={canManageBranches}
                  onToggleCollapse={() => toggleCollapse(branch._id)}
                  onDelete={() => onDeleteBranch(branch._id)}
                >
                  {!isCollapsed && (
                    <div className="structure-departments">
                      {deps.map((dep, depIndex) => (
                        <StructureDepartmentRow
                          key={dep._id}
                          dep={dep}
                          index={depIndex}
                          branchId={branch._id}
                          memberCount={memberCountForDepartment(dep._id)}
                          canDrag={canManageDepartments}
                          onDelete={() => onDeleteDepartment(dep._id)}
                        />
                      ))}

                      <StructureBranchDropZone branchId={branch._id} />

                      {canManageDepartments && (
                        <div className="structure-add-row">
                          <Plus className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                          <input
                            value={newDeptName(branch._id)}
                            onChange={(e) => setNewDeptName(branch._id, e.target.value)}
                            placeholder="Add a department…"
                            className="structure-add-input"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && newDeptName(branch._id).trim()) {
                                onCreateDepartment(branch._id, newDeptName(branch._id).trim());
                                setNewDeptName(branch._id, "");
                              }
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </StructureBranchRow>
              );
            })}

            {canManageBranches && branches.length > 0 && (
              <div className="structure-add-row structure-add-row-branch">
                <Plus className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                <input
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="Add a branch…"
                  className="structure-add-input"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newBranchName.trim()) {
                      onCreateBranch(newBranchName.trim());
                      setNewBranchName("");
                    }
                  }}
                />
              </div>
            )}
          </div>
        </DragDropProvider>
      </div>
    </div>
  );
}

/* ============================================================== */
/*  People tab                                                     */
/* ============================================================== */

type PeopleView = "members" | "invitations";

function PeopleTab({
  data,
  onConfigure,
  onInvite,
  canManageUsers,
  canInvite,
}: {
  data: Overview;
  onConfigure: (user: UserRow) => void;
  onInvite: () => void;
  canManageUsers: boolean;
  canInvite: boolean;
}) {
  const [view, setView] = useState<PeopleView>("members");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const branchMap = useMemo(() => new Map(data.branches.map((b) => [b._id, b.name])), [data.branches]);
  const departmentMap = useMemo(() => new Map(data.departments.map((d) => [d._id, d.name])), [data.departments]);

  const normalized = query.trim().toLowerCase();

  const filteredUsers = useMemo(() => {
    return data.users.filter((user) => {
      if (normalized && !`${user.user.name} ${user.user.email}`.toLowerCase().includes(normalized)) return false;
      if (roleFilter !== "all" && user.membership.role !== roleFilter) return false;
      return true;
    });
  }, [data.users, normalized, roleFilter]);

  const filteredInvitations = useMemo(() => {
    return data.invitations.filter((invitation) => {
      if (normalized && !invitation.email.toLowerCase().includes(normalized)) return false;
      if (roleFilter !== "all" && invitation.role !== roleFilter) return false;
      return true;
    });
  }, [data.invitations, normalized, roleFilter]);

  const filterCount = (roleFilter !== "all" ? 1 : 0) + (query.trim() !== "" ? 1 : 0);
  const isEmpty = view === "members" ? filteredUsers.length === 0 : filteredInvitations.length === 0;

  return (
    <div className="company-tab-body">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="task-view-toggle" aria-label="People view">
          <button type="button" className="task-view-button" data-active={view === "members"} onClick={() => setView("members")}>
            <Users className="h-4 w-4" />
            Members
            <span className="rounded-full bg-[var(--surface-pressed)] px-1.5 text-[11px] font-medium tabular-nums text-[var(--ink-muted)]">
              {data.users.length}
            </span>
          </button>
          <button type="button" className="task-view-button" data-active={view === "invitations"} onClick={() => setView("invitations")}>
            <MailPlus className="h-4 w-4" />
            Invitations
            <span className="rounded-full bg-[var(--surface-pressed)] px-1.5 text-[11px] font-medium tabular-nums text-[var(--ink-muted)]">
              {data.invitations.length}
            </span>
          </button>
        </div>
        <div className="ml-auto flex flex-1 items-center justify-end gap-2">
          <div className="task-search-control" data-open={searchOpen || query.trim() !== ""}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="task-search-input border-none focus:border-none bg-transparent"
              placeholder={view === "members" ? "Search by name or email" : "Search invitations"}
              aria-label={view === "members" ? "Search members" : "Search invitations"}
              tabIndex={searchOpen || query.trim() !== "" ? 0 : -1}
            />
            <button
              type="button"
              className="task-search-button"
              aria-label={query ? "Clear search" : "Search people"}
              onClick={() => {
                if (query) setQuery("");
                else setSearchOpen((open) => !open);
              }}
            >
              {query ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
          </div>
          <CompanyFilterMenu roleFilter={roleFilter} activeCount={filterCount} onRoleChange={setRoleFilter} />
          {canInvite && (
            <Button variant="primary" size="sm" onClick={onInvite}>
              <MailPlus className="h-4 w-4" />
              Invite
            </Button>
          )}
        </div>
      </div>

      {view === "members" ? (
        <div className="company-table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th className="min-w-[220px]">
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    Member
                  </span>
                </th>
                <th className="w-28">Role</th>
                <th className="min-w-[120px]">Branch</th>
                <th className="min-w-[140px]">Department</th>
                <th className="w-28">Status</th>
                <th className="w-32">Joined</th>
                <th className="w-28" />
              </tr>
            </thead>
            <tbody>
              {isEmpty ? (
                <tr>
                  <td colSpan={7} className="!h-auto !border-0 !bg-transparent py-2">
                    <EmptyState
                      icon={Users}
                      title={query || roleFilter !== "all" ? "No matching members" : "No members yet"}
                      message={
                        query || roleFilter !== "all"
                          ? "Try adjusting your search or filters."
                          : "Invite the first person to join this workspace."
                      }
                      action={
                        canInvite && !query && roleFilter === "all" ? (
                          <Button size="sm" variant="primary" onClick={onInvite}>
                            <MailPlus className="h-3.5 w-3.5" />
                            Invite member
                          </Button>
                        ) : undefined
                      }
                    />
                  </td>
                </tr>
              ) : (
                filteredUsers.map((user) => (
                  <tr key={user.membership._id} className="group/row">
                    <td>
                      <div className="flex items-center gap-2.5">
                        <MemberAvatar name={user.user.name} email={user.user.email} />
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--ink)]">{user.user.name || user.user.email}</div>
                          <div className="truncate text-[12px] text-[var(--ink-muted)]">{user.user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={roleTone[user.membership.role]}>{user.membership.role}</Badge>
                    </td>
                    <td className="text-[var(--ink-secondary)]">
                      <span className="truncate">{user.branchIds.map((id) => branchMap.get(id)).filter(Boolean).join(", ") || "—"}</span>
                    </td>
                    <td className="text-[var(--ink-secondary)]">
                      <span className="truncate">{user.departmentIds.map((id) => departmentMap.get(id)).filter(Boolean).join(", ") || "—"}</span>
                    </td>
                    <td>
                      <Badge tone={user.membership.active ? "green" : "neutral"}>{user.membership.active ? "Active" : "Inactive"}</Badge>
                    </td>
                    <td className="text-[12.5px] text-[var(--ink-secondary)]">{formatDate(user.membership.createdAt)}</td>
                    <td className="text-right">
                      {canManageUsers && (
                        <Button size="sm" variant="ghost" onClick={() => onConfigure(user)}>
                          Permissions
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="company-table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th className="min-w-[220px]">
                  <span className="inline-flex items-center gap-1.5">
                    <MailPlus className="h-3.5 w-3.5" />
                    Invitation
                  </span>
                </th>
                <th className="w-28">Role</th>
                <th className="min-w-[120px]">Branch</th>
                <th className="min-w-[140px]">Department</th>
                <th className="w-28">Status</th>
                <th className="w-32">Invited</th>
                <th className="w-28" />
              </tr>
            </thead>
            <tbody>
              {isEmpty ? (
                <tr>
                  <td colSpan={7} className="!h-auto !border-0 !bg-transparent py-2">
                    <EmptyState
                      icon={MailPlus}
                      title={query || roleFilter !== "all" ? "No matching invitations" : "No pending invitations"}
                      message={
                        query || roleFilter !== "all"
                          ? "Try adjusting your search or filters."
                          : "Invite a person to send them a join link."
                      }
                      action={
                        canInvite && !query && roleFilter === "all" ? (
                          <Button size="sm" variant="primary" onClick={onInvite}>
                            <MailPlus className="h-3.5 w-3.5" />
                            Invite member
                          </Button>
                        ) : undefined
                      }
                    />
                  </td>
                </tr>
              ) : (
                filteredInvitations.map((invitation) => (
                  <tr key={invitation._id} className="group/row">
                    <td>
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)] text-[var(--ink-faint)]">
                          <MailPlus className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--ink)]">{invitation.email}</div>
                          <div className="truncate text-[12px] text-[var(--ink-muted)]">Pending invitation</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={roleTone[invitation.role]}>{invitation.role}</Badge>
                    </td>
                    <td className="text-[var(--ink-secondary)]">
                      <span className="truncate">{invitation.branchIds.map((id) => branchMap.get(id)).filter(Boolean).join(", ") || "—"}</span>
                    </td>
                    <td className="text-[var(--ink-secondary)]">
                      <span className="truncate">{invitation.departmentIds.map((id) => departmentMap.get(id)).filter(Boolean).join(", ") || "—"}</span>
                    </td>
                    <td>
                      <Badge tone="yellow" className="capitalize">
                        {invitation.status}
                      </Badge>
                    </td>
                    <td className="text-[12.5px] text-[var(--ink-secondary)]">{formatDate(invitation.createdAt)}</td>
                    <td />
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================================================== */
/*  Permissions tab                                                */
/* ============================================================== */

function PermissionsTab({ data, onConfigure, canManageUsers }: { data: Overview; onConfigure: (user: UserRow) => void; canManageUsers: boolean }) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const normalized = query.trim().toLowerCase();

  const usersWithOverrides = useMemo(() => {
    return data.users
      .filter((user) => {
        if (!normalized) return true;
        return `${user.user.name} ${user.user.email}`.toLowerCase().includes(normalized);
      })
      .sort((a, b) => b.overrides.length - a.overrides.length);
  }, [data.users, normalized]);

  return (
    <div className="company-tab-body">
      <div className="grid gap-3 md:grid-cols-3">
        {roles.map((role) => {
          const members = data.users.filter((user) => user.membership.role === role).length;
          return (
            <div key={role} className="company-role-card">
              <div className="flex items-center justify-between gap-2">
                <Badge tone={roleTone[role]}>{role}</Badge>
                <span className="text-[12px] text-[var(--ink-faint)] tabular-nums">{members} member{members === 1 ? "" : "s"}</span>
              </div>
              <div className="mt-3 text-[13px] font-medium text-[var(--ink)] tabular-nums">{defaultRoleCapabilities[role].length} default permissions</div>
              <p className="mt-1 text-[12px] leading-5 text-[var(--ink-muted)]">Overrides below should stay rare so roles remain predictable.</p>
            </div>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div>
          <p className="text-[13px] text-[var(--ink-secondary)]">
            Permissions are role-based by default. Add overrides only when a member needs an exception.
          </p>
        </div>
        <div className="ml-auto flex flex-1 items-center justify-end gap-2">
          <div className="task-search-control" data-open={searchOpen || query.trim() !== ""}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="task-search-input border-none focus:border-none bg-transparent"
              placeholder="Search people"
              aria-label="Search people by name or email"
              tabIndex={searchOpen || query.trim() !== "" ? 0 : -1}
            />
            <button
              type="button"
              className="task-search-button"
              aria-label={query ? "Clear search" : "Search people"}
              onClick={() => {
                if (query) setQuery("");
                else setSearchOpen((open) => !open);
              }}
            >
              {query ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="company-table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th className="min-w-[220px]">
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  Member
                </span>
              </th>
              <th className="w-28">Role</th>
              <th className="min-w-[260px]">Overrides</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {usersWithOverrides.length === 0 ? (
              <tr>
                <td colSpan={4} className="!h-auto !border-0 !bg-transparent py-2">
                  <EmptyState
                    icon={ShieldCheck}
                    title={query ? "No matching members" : "No manual exceptions"}
                    message={
                      query
                        ? "Try a different name or email."
                        : "Everyone follows their role defaults. Open a member from the People tab to add an override if needed."
                    }
                  />
                </td>
              </tr>
            ) : (
              usersWithOverrides.map((user) => {
                const overrideLabels = user.overrides
                  .map((override) => capabilityLabels[override.capability as Capability] ?? override.capability)
                  .slice(0, 3);
                const extra = user.overrides.length - overrideLabels.length;
                return (
                  <tr key={user.membership._id} className="group/row">
                    <td>
                      <div className="flex items-center gap-2.5">
                        <MemberAvatar name={user.user.name} email={user.user.email} />
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--ink)]">{user.user.name || user.user.email}</div>
                          <div className="truncate text-[12px] text-[var(--ink-muted)]">{user.user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={roleTone[user.membership.role]}>{user.membership.role}</Badge>
                    </td>
                    <td>
                      <div className="flex min-w-0 flex-col">
                        <span className="text-[12.5px] text-[var(--ink-secondary)] tabular-nums">
                          {user.overrides.length} override{user.overrides.length === 1 ? "" : "s"}
                        </span>
                        <span className="truncate text-[11.5px] text-[var(--ink-faint)]">
                          {overrideLabels.join(", ")}
                          {extra > 0 && `, +${extra} more`}
                        </span>
                      </div>
                    </td>
                    <td className="text-right">
                      {canManageUsers && (
                        <Button size="sm" variant="ghost" onClick={() => onConfigure(user)}>
                          Configure
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================================================== */
/*  Invite dialog                                                  */
/* ============================================================== */

function InviteDialog({
  open,
  onOpenChange,
  data,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Overview;
  onInvite: (args: { email: string; role: Role; branchId: Id<"branches"> | ""; departmentId: Id<"departments"> | "" }) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("Employee");
  const [branchId, setBranchId] = useState<Id<"branches"> | "">("");
  const [departmentId, setDepartmentId] = useState<Id<"departments"> | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail("");
      setRole("Employee");
      setBranchId("");
      setDepartmentId("");
      setError(null);
    }
  }, [open]);

  // Reset department when branch changes (departments are scoped to branches)
  useEffect(() => {
    if (!branchId) {
      setDepartmentId("");
      return;
    }
    setDepartmentId((current) => {
      if (!current) return "";
      const stillValid = data.departments.some((d) => d._id === current && d.branchId === branchId);
      return stillValid ? current : "";
    });
  }, [branchId, data.departments]);

  const filteredDepartments = useMemo(() => {
    if (!branchId) return data.departments;
    return data.departments.filter((department) => department.branchId === branchId);
  }, [data.departments, branchId]);

  async function submit() {
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(560px,94dvh)] w-[min(480px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
          <div className="flex items-start justify-between border-b border-[var(--hairline)] px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Invite member</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">Set their starting role and team placement.</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Email</span>
                  <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="member@example.com" type="email" autoFocus />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Role</span>
                    <SelectField value={role} onChange={setRole}>
                      {roles.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </SelectField>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Branch</span>
                    <SelectField value={branchId} onChange={setBranchId}>
                      <option value="">None</option>
                      {data.branches.map((branch) => (
                        <option key={branch._id} value={branch._id}>
                          {branch.name}
                        </option>
                      ))}
                    </SelectField>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Department</span>
                    <SelectField value={departmentId} onChange={setDepartmentId} disabled={!branchId}>
                      <option value="">None</option>
                      {filteredDepartments.map((department) => (
                        <option key={department._id} value={department._id}>
                          {department.name}
                        </option>
                      ))}
                    </SelectField>
                  </label>
                </div>
              </div>
              {error && (
                <p className="alert-error mt-4 rounded-md px-3 py-2 text-[12.5px]" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--hairline)] bg-[var(--surface)] px-5 py-3">
              <Dialog.Close asChild>
                <Button type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? "Sending..." : "Send invite"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ============================================================== */
/*  Permissions dialog                                             */
/* ============================================================== */

function MultiSelectList<T extends string>({
  title,
  empty,
  options,
  selected,
  onChange,
}: {
  title: string;
  empty: string;
  options: { id: T; label: string; helper?: string }[];
  selected: T[];
  onChange: (ids: T[]) => void;
}) {
  const selectedSet = new Set(selected);
  return (
    <div>
      <div className="mb-1.5 text-[11.5px] font-medium text-[var(--ink-muted)]">{title}</div>
      <div className="max-h-32 overflow-auto rounded-md border border-[var(--hairline)] p-1">
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-[12px] text-[var(--ink-muted)]">{empty}</div>
        ) : (
          options.map((option) => {
            const toggle = () => onChange(selectedSet.has(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id]);
            return (
              <div key={option.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--surface-hover)]">
                <Checkbox checked={selectedSet.has(option.id)} aria-label={option.label} onCheckedChange={toggle} />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={toggle}>
                  <span className="block truncate text-[13px] text-[var(--ink)]">{option.label}</span>
                  {option.helper && <span className="block truncate text-[11px] text-[var(--ink-muted)]">{option.helper}</span>}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function PermissionGroups({
  role,
  overrides,
  onChange,
}: {
  role: Role;
  overrides: Record<Capability, Effect>;
  onChange: (next: Record<Capability, Effect>) => void;
}) {
  const effective = useMemo(() => effectiveCapabilities(role, overrides), [role, overrides]);
  return (
    <div className="space-y-5">
      {capabilityGroups.map((group) => (
        <section key={group.title}>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">{group.title}</div>
          <div className="grid gap-px lg:grid-cols-2">
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
                    <span className="block text-[13px] text-[var(--ink)]">{capabilityLabels[capability]}</span>
                    <span className="text-[11px] text-[var(--ink-muted)]">
                      {effect === "inherit" ? (inherited ? "Inherited from role" : "Off by default") : effect === "allow" ? "Manually allowed" : "Manually denied"}
                    </span>
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

function PermissionsDialog({
  open,
  onOpenChange,
  data,
  user,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Overview;
  user?: UserRow;
  onSave: (user: UserRow, draft: PermissionDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PermissionDraft>(() =>
    user
      ? draftFromUser(user)
      : { role: "Employee", branchIds: [], departmentIds: [], managedBranchIds: [], managedDepartmentIds: [], managedUserMembershipIds: [], overrides: { ...emptyOverrides } },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && user) {
      setDraft(draftFromUser(user));
      setError(null);
    }
  }, [open, user]);

  if (!user) return null;

  const branches = data.branches.map((branch) => ({ id: branch._id, label: branch.name }));
  const departments = data.departments.map((department) => ({
    id: department._id,
    label: department.name,
    helper: data.branches.find((branch) => branch._id === department.branchId)?.name,
  }));
  const people = data.users
    .filter((row) => row.membership._id !== user.membership._id)
    .map((row) => ({ id: row.membership._id, label: row.user.name || row.user.email, helper: row.membership.role }));
  const overrideCount = Object.values(draft.overrides).filter((effect) => effect !== "inherit").length;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await onSave(user!, draft);
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(880px,94dvh)] w-[min(900px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
          <div className="flex items-start justify-between border-b border-[var(--hairline)] px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <MemberAvatar name={user.user.name} email={user.user.email} size="md" />
              <div className="min-w-0">
                <Dialog.Title className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{user.user.name || user.user.email}</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">Role defaults are inherited first. Toggle permissions only for exceptions.</Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-auto p-5">
            <div className="grid gap-5 xl:grid-cols-[300px_1fr]">
              <aside className="space-y-4">
                <div className="company-dialog-card">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Role</div>
                  <SelectField value={draft.role} onChange={(role) => setDraft({ ...draft, role })}>
                    {roles.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </SelectField>
                </div>
                <div className="company-dialog-card space-y-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Member placement</div>
                  <MultiSelectList title="Branches" empty="No branches" options={branches} selected={draft.branchIds} onChange={(branchIds) => setDraft({ ...draft, branchIds })} />
                  <MultiSelectList title="Departments" empty="No departments" options={departments} selected={draft.departmentIds} onChange={(departmentIds) => setDraft({ ...draft, departmentIds })} />
                </div>
                <div className="company-dialog-card space-y-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Managed scope</div>
                  <MultiSelectList title="People under this user" empty="No other people" options={people} selected={draft.managedUserMembershipIds} onChange={(managedUserMembershipIds) => setDraft({ ...draft, managedUserMembershipIds })} />
                  <MultiSelectList title="Branches under this user" empty="No branches" options={branches} selected={draft.managedBranchIds} onChange={(managedBranchIds) => setDraft({ ...draft, managedBranchIds })} />
                  <MultiSelectList title="Departments under this user" empty="No departments" options={departments} selected={draft.managedDepartmentIds} onChange={(managedDepartmentIds) => setDraft({ ...draft, managedDepartmentIds })} />
                </div>
              </aside>
              <div className="company-dialog-card">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Permissions</div>
                <PermissionGroups role={draft.role} overrides={draft.overrides} onChange={(overrides) => setDraft({ ...draft, overrides })} />
              </div>
            </div>
          </div>

          {error && (
            <p className="alert-error mx-5 mb-3 rounded-md px-3 py-2 text-[12.5px]" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between border-t border-[var(--hairline)] bg-[var(--surface)] px-5 py-3 text-[12px] text-[var(--ink-muted)]">
            <span className="tabular-nums">{overrideCount} manual override{overrideCount === 1 ? "" : "s"}</span>
            <div className="flex gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button variant="primary" onClick={submit} disabled={saving}>
                {saving ? "Saving..." : "Save permissions"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ============================================================== */
/*  Sidebar nav                                                    */
/* ============================================================== */

function CompanySidebar({ tab, setTab, data }: { tab: TabValue; setTab: (value: TabValue) => void; data: Overview }) {
  return (
    <aside className="company-nav" aria-label="Company management sections">
      <nav className="company-nav-list" role="tablist" aria-label="Company settings">
        {TABS.map((item) => {
          const Icon = item.icon;
          const isActive = tab === item.value;
          const count = item.getCount?.(data);
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-active={isActive}
              onClick={() => setTab(item.value)}
              className="company-nav-item"
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{item.label}</span>
              {count !== undefined && count > 0 && <span className="company-nav-count">{count}</span>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

/* ============================================================== */
/*  Skeleton                                                       */
/* ============================================================== */

function CompanySkeleton() {
  return (
    <div className="company-page animate-pulse">
      <div className="company-shell">
        <div className="company-sidebar-wrap">
          <div className="company-nav space-y-4">
            <div className="company-nav-list space-y-0.5 p-1">
              <div className="h-[30px] rounded-md bg-[var(--surface-hover)]" />
              <div className="h-[30px] rounded-md bg-[var(--surface-hover)]" />
              <div className="h-[30px] rounded-md bg-[var(--surface-hover)]" />
              <div className="h-[30px] rounded-md bg-[var(--surface-hover)]" />
            </div>
          </div>
        </div>
        <div className="company-main">
          <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
          <div className="mt-6 h-40 rounded-xl bg-[var(--surface-muted)]" />
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
            <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
            <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
            <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================== */
/*  Page                                                           */
/* ============================================================== */

export default function Company() {
  const { activeCompanyId, active } = useCompany();
  const data = useQuery(api.companyManagement.overview, activeCompanyId ? { companyId: activeCompanyId } : "skip") as Overview | undefined;
  const updateCompanyName = useMutation(api.companyManagement.updateCompanyName);
  const createBranch = useMutation(api.companyManagement.createBranch);
  const createDepartment = useMutation(api.companyManagement.createDepartment);
  const deleteBranch = useMutation(api.companyManagement.deleteBranch);
  const deleteDepartment = useMutation(api.companyManagement.deleteDepartment);
  const reorderBranches = useMutation(api.companyManagement.reorderBranches);
  const moveDepartment = useMutation(api.companyManagement.moveDepartment);
  const invite = useAction(api.companyManagement.inviteUser);
  const setUserPermissions = useMutation(api.companyManagement.setUserPermissions).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => row.membership._id === args.membershipId ? {
        ...row,
        membership: { ...row.membership, role: args.role },
        branchIds: args.branchIds,
        departmentIds: args.departmentIds,
        scope: { branchIds: args.managedBranchIds, departmentIds: args.managedDepartmentIds, userMembershipIds: args.managedUserMembershipIds },
        overrides: args.permissionOverrides.flatMap((override) => override.effect === "inherit" ? [] : [{ capability: override.capability, effect: override.effect }]),
      } : row),
    } as any);
  });

  const [tab, setTab] = useState<TabValue>("general");
  const [companyName, setCompanyName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [permissionsMembershipId, setPermissionsMembershipId] = useState<Id<"companyMemberships"> | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setCompanyName(data.company?.name ?? active?.company.name ?? "");
    }
  }, [active?.company.name, data]);

  const permissionsUser = useMemo(() => data?.users.find((user) => user.membership._id === permissionsMembershipId), [data?.users, permissionsMembershipId]);

  if (!data) return <CompanySkeleton />;

  const currentCompany = data.company ?? active?.company;
  const nameDirty = companyName.trim() !== (currentCompany?.name ?? "") && companyName.trim() !== "";
  const canManageSettings = active?.capabilities.includes("company:manage_settings") ?? false;
  const canManageBranches = active?.capabilities.includes("company:manage_branches") ?? false;
  const canManageDepartments = active?.capabilities.includes("company:manage_departments") ?? false;
  const canManageUsers = active?.capabilities.includes("company:manage_users") ?? false;
  const canInvite = active?.capabilities.includes("company:invite_users") ?? false;

  async function run(action: () => Promise<unknown>, message = "Something went wrong.") {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : message);
    }
  }

  async function saveCompanyName() {
    if (!activeCompanyId || !nameDirty) return;
    setSavingName(true);
    try {
      await updateCompanyName({ companyId: activeCompanyId, name: companyName.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the company name.");
    } finally {
      setSavingName(false);
    }
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
    if (!activeCompanyId || !data) return;
    await setUserPermissions({
      companyId: activeCompanyId,
      membershipId: user.membership._id,
      role: draft.role,
      branchIds: draft.branchIds,
      departmentIds: draft.departmentIds,
      managedBranchIds: draft.managedBranchIds,
      managedDepartmentIds: draft.managedDepartmentIds,
      managedUserMembershipIds: draft.managedUserMembershipIds,
      permissionOverrides: data.capabilities.map((capability) => ({ capability, effect: draft.overrides[capability] })),
    });
  }

  return (
    <div className="company-page">
      {error && (
        <div className="alert-error company-alert" role="alert">
          <span>{error}</span>
          <button type="button" className="task-icon-btn h-6 w-6" onClick={() => setError(null)} aria-label="Dismiss error">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="company-shell">
        <div className="company-sidebar-wrap">
          <CompanySidebar tab={tab} setTab={setTab} data={data} />
        </div>
        <main className="company-main">
          <CompanyContentHeader tab={tab} />

          <div className="company-main-body">
            {tab === "general" && (
              <GeneralTab
                data={data}
                companyName={companyName}
                setCompanyName={setCompanyName}
                nameDirty={nameDirty}
                savingName={savingName}
                canManageSettings={canManageSettings}
                onSaveName={saveCompanyName}
              />
            )}
            {tab === "structure" && (
              <StructureTab
                data={data}
                canManageBranches={canManageBranches}
                canManageDepartments={canManageDepartments}
                onCreateBranch={(name) => activeCompanyId && run(async () => createBranch({ companyId: activeCompanyId, name }), "Could not create branch.")}
                onCreateDepartment={(branchId, name) => activeCompanyId && run(async () => createDepartment({ companyId: activeCompanyId, branchId, name }), "Could not create department.")}
                onDeleteBranch={(branchId) =>
                  activeCompanyId && window.confirm("Delete this branch? Departments and assignments must be removed first.") && run(async () => deleteBranch({ companyId: activeCompanyId, branchId }), "Could not delete branch.")
                }
                onDeleteDepartment={(departmentId) =>
                  activeCompanyId && window.confirm("Delete this department? Assignments must be removed first.") && run(async () => deleteDepartment({ companyId: activeCompanyId, departmentId }), "Could not delete department.")
                }
                onReorderBranches={(orderedBranchIds) => activeCompanyId && run(async () => reorderBranches({ companyId: activeCompanyId, orderedBranchIds }), "Could not reorder branches.")}
                onMoveDepartment={(departmentId, toBranchId, orderedDepartmentIds) =>
                  activeCompanyId && run(async () => moveDepartment({ companyId: activeCompanyId, departmentId, toBranchId, orderedDepartmentIds }), "Could not move department.")
                }
              />
            )}
            {tab === "people" && (
              <PeopleTab
                data={data}
                onConfigure={(user) => setPermissionsMembershipId(user.membership._id)}
                onInvite={() => setInviteOpen(true)}
                canManageUsers={canManageUsers}
                canInvite={canInvite}
              />
            )}
            {tab === "permissions" && <PermissionsTab data={data} onConfigure={(user) => setPermissionsMembershipId(user.membership._id)} canManageUsers={canManageUsers} />}
          </div>
        </main>
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} data={data} onInvite={inviteMember} />
      <PermissionsDialog open={Boolean(permissionsMembershipId)} onOpenChange={(open) => !open && setPermissionsMembershipId(undefined)} data={data} user={permissionsUser} onSave={savePermissions} />
    </div>
  );
}
