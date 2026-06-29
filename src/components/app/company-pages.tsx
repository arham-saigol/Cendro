"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Building2,
  CalendarDays,
  Check,
  ChevronsRight,
  ChevronDown,
  ChevronRight,
  CirclePause,
  GripVertical,
  Layers,
  LucideIcon,
  MailPlus,
  Network,
  PanelRight,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserCog,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import type { DragEndEvent } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "@/components/app/company-context";
import { DETAIL_DRAWER_CLOSE_MS } from "@/components/app/detail-drawer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { browserTimeZone, DEFAULT_TIME_ZONE, timeZoneOptions } from "@/lib/time-zones";
import { cn, formatDate, initials } from "@/lib/utils";
import { canAccessCompanyManagement, capabilityGroups, capabilityLabels, defaultRoleCapabilities, roles, type Capability, type Role } from "@/lib/permissions";

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
  company?: { _id: Id<"companies">; name: string; timeZone: string; hasTimeZone: boolean };
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

const TABS: { value: TabValue; label: string; icon: LucideIcon }[] = [
  { value: "general", label: "General", icon: Settings },
  { value: "structure", label: "Structure", icon: Network },
  { value: "people", label: "People", icon: Users },
  { value: "permissions", label: "Permissions", icon: ShieldCheck },
];

function canViewCompanyTab(tab: TabValue, capabilities: readonly string[] | null | undefined) {
  if (tab === "general") return Boolean(capabilities?.includes("company:manage_settings"));
  if (tab === "structure") return Boolean(capabilities?.some((capability) => capability === "company:manage_branches" || capability === "company:manage_departments"));
  if (tab === "people") return Boolean(capabilities?.some((capability) => capability === "company:manage_users" || capability === "company:invite_users" || capability === "company:manage_permissions"));
  return Boolean(capabilities?.includes("company:manage_permissions"));
}

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

function ColumnHeading({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

function PeopleCellMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = "—",
  renderValue,
}: {
  value: T;
  options: { value: T; label: string; helper?: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
  renderValue?: (option: { value: T; label: string; helper?: string } | undefined) => React.ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const selected = options.find((option) => option.value === value);
  const label = selected?.label || placeholder;
  const content = renderValue ? renderValue(selected) : <span className={cn("min-w-0 truncate", !selected && "text-[var(--ink-faint)]")}>{label}</span>;

  function measure() {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setRect({ top: bounds.top, left: bounds.left - 14, width: Math.max(bounds.width + 28, 220) });
  }

  useEffect(() => {
    if (!open) return;
    measure();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  if (disabled) {
    return <span className="task-cell-control cursor-not-allowed opacity-55">{content}</span>;
  }

  return (
    <span className="task-cell-popover-root">
      <button
        ref={triggerRef}
        type="button"
        className="task-cell-control"
        data-interactive="true"
        data-cell-popover-open={open ? "true" : undefined}
        onClick={(event) => { event.stopPropagation(); if (!open) measure(); setOpen(!open); }}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        {content}
      </button>
      {open && rect && (
        <>
          <button type="button" aria-label="Close menu" className="task-cell-popover-backdrop" onClick={(event) => { event.stopPropagation(); setOpen(false); }} />
          <div className="task-cell-popover" style={{ top: rect.top, left: rect.left, width: rect.width }} data-interactive="true" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="task-cell-popover-header">{content}</div>
            <div className="task-cell-popover-body">
              {options.map((option) => (
                <button key={option.value} type="button" onClick={() => { setOpen(false); if (option.value !== value) onChange(option.value); }} className="task-cell-popover-item">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.helper && <span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{option.helper}</span>}
                  </span>
                  {option.value === value && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
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
  timeZone,
  setTimeZone,
  savingTimeZone,
  canManageSettings,
  nameDirty,
  savingName,
  onSaveName,
  onSaveTimeZone,
}: {
  data: Overview;
  companyName: string;
  setCompanyName: (value: string) => void;
  timeZone: string;
  setTimeZone: (value: string) => void;
  savingTimeZone: boolean;
  canManageSettings: boolean;
  nameDirty: boolean;
  savingName: boolean;
  onSaveName: () => Promise<void> | void;
  onSaveTimeZone: (timeZone: string) => Promise<void> | void;
}) {
  const options = timeZoneOptions(timeZone);
  const savedTimeZone = data.company?.timeZone ?? DEFAULT_TIME_ZONE;
  const timeZoneDirty = timeZone !== savedTimeZone;

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
              <div className="company-settings-label">Time zone</div>
              <p className="company-settings-help">Used for JD task cycle boundaries. Browser detection falls back to GMT+5.</p>
            </div>
            <div className="company-settings-control">
              <div className="company-name-field">
                <SelectField value={timeZone} onChange={(value) => { setTimeZone(value); void onSaveTimeZone(value); }} disabled={!canManageSettings || savingTimeZone} className="min-w-[220px]">
                  {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SelectField>
                {timeZoneDirty && canManageSettings && <span className="text-[12px] text-[var(--ink-muted)]">Saving…</span>}
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
  onReorderBranches: (orderedBranchIds: Id<"branches">[]) => Promise<void>;
  onMoveDepartment: (departmentId: Id<"departments">, toBranchId: Id<"branches">, orderedDepartmentIds: Id<"departments">[]) => Promise<void>;
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

  async function commitDepartmentToBranch(deptId: Id<"departments">, toBranchId: Id<"branches">) {
    const previousDepartments = departments;
    const dragged = departments.find((d) => d._id === deptId);
    if (!dragged) return;
    const without = departments.filter((d) => d._id !== deptId);
    const toList = without.filter((d) => d.branchId === toBranchId);
    toList.push({ ...dragged, branchId: toBranchId });
    const reindexed = toList.map((d, i) => ({ ...d, branchId: toBranchId, order: i }));
    const others = without.filter((d) => d.branchId !== toBranchId);
    setDepartments([...others, ...reindexed]);
    try {
      await onMoveDepartment(deptId, toBranchId, reindexed.map((d) => d._id));
      expand(toBranchId);
    } catch {
      setDepartments(previousDepartments);
    }
  }

  async function commitDepartmentSort(
    deptId: Id<"departments">,
    fromBranch: Id<"branches">,
    toBranch: Id<"branches">,
    toIndex: number,
  ) {
    const previousDepartments = departments;
    const dragged = departments.find((d) => d._id === deptId);
    if (!dragged) return;
    const without = departments.filter((d) => d._id !== deptId);
    const toList = without.filter((d) => d.branchId === toBranch);
    toList.splice(toIndex, 0, { ...dragged, branchId: toBranch });
    const reindexed = toList.map((d, i) => ({ ...d, branchId: toBranch, order: i }));
    const others = without.filter((d) => d.branchId !== toBranch);
    setDepartments([...others, ...reindexed]);
    try {
      await onMoveDepartment(deptId, toBranch, reindexed.map((d) => d._id));
      if (fromBranch !== toBranch) expand(toBranch);
    } catch {
      setDepartments(previousDepartments);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    isDragging.current = false;
    if (event.canceled) return;
    const { source, target } = event.operation;
    if (!source) return;

    // Dropped onto a branch drop zone → append only departments to that branch.
    if (target?.data?.kind === "branchZone") {
      if (source.data?.kind !== DEPT_TYPE) return;
      void commitDepartmentToBranch(source.id as Id<"departments">, target.data.branchId as Id<"branches">);
      return;
    }

    if (!isSortable(source)) return;

    // Branch reorder (top-level group).
    if (source.data?.kind === BRANCH_TYPE) {
      if (source.initialGroup !== BRANCH_GROUP || source.initialIndex === source.index) return;
      const previousBranches = branches;
      const reordered = arrayMove(branches, source.initialIndex, source.index).map((b, i) => ({ ...b, order: i }));
      setBranches(reordered);
      void onReorderBranches(reordered.map((b) => b._id)).catch(() => setBranches(previousBranches));
      return;
    }

    // Department move (within or across branches).
    if (source.data?.kind !== DEPT_TYPE) return;
    const fromBranch = source.initialGroup as Id<"branches">;
    const toBranch = source.group as Id<"branches">;
    if (!fromBranch || !toBranch) return;
    void commitDepartmentSort(source.id as Id<"departments">, fromBranch, toBranch, source.index);
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
  onInvite,
  onRoleChange,
  onBranchChange,
  onDepartmentChange,
  onStatusChange,
  onRemoveUsers,
  canManageUsers,
  canManagePermissions,
  canInvite,
}: {
  data: Overview;
  onInvite: () => void;
  onRoleChange: (user: UserRow, role: Role) => Promise<void>;
  onBranchChange: (user: UserRow, branchId: Id<"branches"> | "") => Promise<void>;
  onDepartmentChange: (user: UserRow, departmentId: Id<"departments"> | "") => Promise<void>;
  onStatusChange: (user: UserRow, active: boolean) => Promise<void>;
  onRemoveUsers: (membershipIds: Id<"companyMemberships">[]) => Promise<void>;
  canManageUsers: boolean;
  canManagePermissions: boolean;
  canInvite: boolean;
}) {
  const [view, setView] = useState<PeopleView>("members");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<Id<"companyMemberships">>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const branchMap = useMemo(() => new Map(data.branches.map((b) => [b._id, b.name])), [data.branches]);
  const departmentMap = useMemo(() => new Map(data.departments.map((d) => [d._id, d.name])), [data.departments]);
  const normalized = query.trim().toLowerCase();
  const filteredUsers = useMemo(() => data.users.filter((user) => (!normalized || `${user.user.name} ${user.user.email}`.toLowerCase().includes(normalized)) && (roleFilter === "all" || user.membership.role === roleFilter)), [data.users, normalized, roleFilter]);
  const filteredInvitations = useMemo(() => data.invitations.filter((invitation) => (!normalized || invitation.email.toLowerCase().includes(normalized)) && (roleFilter === "all" || invitation.role === roleFilter)), [data.invitations, normalized, roleFilter]);
  const visibleUserIds = filteredUsers.map((user) => user.membership._id);
  const selectedVisibleCount = visibleUserIds.reduce((count, id) => count + (selectedIds.has(id) ? 1 : 0), 0);
  const allVisibleSelected = filteredUsers.length > 0 && selectedVisibleCount === filteredUsers.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectionCount = selectedIds.size;

  useEffect(() => {
    setSelectedIds((current) => {
      const known = new Set(data.users.map((user) => user.membership._id));
      const next = new Set(Array.from(current).filter((id) => known.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [data.users]);
  useEffect(() => { if (view !== "members" && selectedIds.size > 0) setSelectedIds(new Set()); }, [selectedIds.size, view]);

  function toggleOne(id: Id<"companyMemberships">) {
    setSelectedIds((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
    setRemoveError(null);
  }
  function toggleAllVisible() {
    setSelectedIds((current) => { const next = new Set(current); if (allVisibleSelected) for (const id of visibleUserIds) next.delete(id); else for (const id of visibleUserIds) next.add(id); return next; });
    setRemoveError(null);
  }
  function clearSelection() { setSelectedIds(new Set()); setRemoveError(null); }
  async function removeSelected() {
    if (selectionCount === 0 || removing) return;
    setRemoving(true); setRemoveError(null);
    try { await onRemoveUsers(Array.from(selectedIds)); setSelectedIds(new Set()); }
    catch (err) { setRemoveError(err instanceof Error ? err.message : "Could not remove selected users."); }
    finally { setRemoving(false); }
  }

  const filterCount = (roleFilter !== "all" ? 1 : 0) + (query.trim() !== "" ? 1 : 0);
  const isEmpty = view === "members" ? filteredUsers.length === 0 : filteredInvitations.length === 0;

  return (
    <div className="company-tab-body company-people-body">
      <div className="flex flex-wrap items-center gap-2">
        <div className="task-view-toggle" aria-label="People view">
          <button type="button" className="task-view-button" data-active={view === "members"} onClick={() => setView("members")}><Users className="h-4 w-4" />Members<span className="rounded-full bg-[var(--surface-pressed)] px-1.5 text-[11px] font-medium tabular-nums text-[var(--ink-muted)]">{data.users.length}</span></button>
          <button type="button" className="task-view-button" data-active={view === "invitations"} onClick={() => setView("invitations")}><MailPlus className="h-4 w-4" />Invitations<span className="rounded-full bg-[var(--surface-pressed)] px-1.5 text-[11px] font-medium tabular-nums text-[var(--ink-muted)]">{data.invitations.length}</span></button>
        </div>
        <div className="ml-auto flex flex-1 items-center justify-end gap-2">
          <div className="task-search-control" data-open={searchOpen || query.trim() !== ""}>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} className="task-search-input border-none focus:border-none bg-transparent" placeholder={view === "members" ? "Search by name or email" : "Search invitations"} aria-label={view === "members" ? "Search members" : "Search invitations"} tabIndex={searchOpen || query.trim() !== "" ? 0 : -1} />
            <button type="button" className="task-search-button" aria-label={query ? "Clear search" : "Search people"} onClick={() => { if (query) setQuery(""); else setSearchOpen((open) => !open); }}>{query ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}</button>
          </div>
          <CompanyFilterMenu roleFilter={roleFilter} activeCount={filterCount} onRoleChange={setRoleFilter} />
          {canInvite && <Button variant="primary" size="sm" onClick={onInvite}><MailPlus className="h-4 w-4" />Invite</Button>}
        </div>
      </div>

      {view === "members" ? (
        <div className="relative">
          {selectionCount > 0 && <div className="task-selection-layer"><div className="task-selection-pill" role="status" aria-live="polite"><span className="task-selection-pill-count">{selectionCount} selected</span><span className="task-selection-pill-divider" aria-hidden="true" /><button type="button" className="task-selection-pill-btn" onClick={clearSelection} disabled={removing} aria-label="Cancel selection"><X className="h-4 w-4" /></button><span className="task-selection-pill-divider" aria-hidden="true" /><button type="button" className="task-selection-pill-btn" data-danger="true" onClick={() => void removeSelected()} disabled={removing} aria-label={selectionCount === 1 ? "Remove selected user" : `Remove ${selectionCount} selected users`} title="Remove user"><UserMinus className="h-4 w-4" /></button></div>{removeError && <p className="alert-error task-selection-error" role="alert">{removeError}</p>}</div>}
          <div className="company-table-wrap task-table-wrap relative -ml-11 w-[calc(100%+2.75rem)] overflow-x-auto pl-11">
            {canManageUsers && filteredUsers.length > 0 && <div className="task-checkbox-rail pointer-events-none absolute left-0 top-0 z-10 flex w-11 flex-col pr-2"><div className="flex h-9 items-center justify-end group/head pointer-events-auto"><Checkbox checked={allVisibleSelected} indeterminate={someVisibleSelected} onCheckedChange={toggleAllVisible} aria-label={allVisibleSelected ? "Unselect all users" : "Select all users"} className={cn("transition-opacity", selectionCount > 0 ? "opacity-100" : "opacity-0 group-hover/head:opacity-100")} /></div>{filteredUsers.map((user) => { const isChecked = selectedIds.has(user.membership._id); return <div key={`rail-${user.membership._id}`} className="group/rail flex h-[41px] items-center justify-end pointer-events-auto"><Checkbox checked={isChecked} onCheckedChange={() => toggleOne(user.membership._id)} aria-label={isChecked ? `Unselect ${user.user.name || user.user.email}` : `Select ${user.user.name || user.user.email}`} className={cn("transition-opacity", isChecked ? "opacity-100" : "opacity-0 group-hover/rail:opacity-100 focus-visible:opacity-100")} /></div>; })}</div>}
            <table className="task-table">
              <thead><tr className="group/head"><th className="min-w-[220px]"><ColumnHeading icon={Users}>Member</ColumnHeading></th><th className="w-32"><ColumnHeading icon={UserCog}>Role</ColumnHeading></th><th className="min-w-[140px]"><ColumnHeading icon={Building2}>Branch</ColumnHeading></th><th className="min-w-[160px]"><ColumnHeading icon={Layers}>Department</ColumnHeading></th><th className="w-28"><ColumnHeading icon={CirclePause}>Status</ColumnHeading></th><th className="w-32"><ColumnHeading icon={CalendarDays}>Joined</ColumnHeading></th></tr></thead>
              <tbody>
                {isEmpty ? <tr><td colSpan={6} className="!h-auto !border-0 !bg-transparent py-2"><EmptyState icon={Users} title={query || roleFilter !== "all" ? "No matching members" : "No members yet"} message={query || roleFilter !== "all" ? "Try adjusting your search or filters." : "Invite the first person to join this workspace."} action={canInvite && !query && roleFilter === "all" ? <Button size="sm" variant="primary" onClick={onInvite}><MailPlus className="h-3.5 w-3.5" />Invite member</Button> : undefined} /></td></tr> : filteredUsers.map((user) => {
                  const isChecked = selectedIds.has(user.membership._id);
                  const branchId: Id<"branches"> | "" = user.branchIds[0] ?? "";
                  const departmentId: Id<"departments"> | "" = user.departmentIds[0] ?? "";
                  const branchOptions: { value: Id<"branches"> | ""; label: string }[] = [{ value: "", label: "No branch" }, ...data.branches.map((branch) => ({ value: branch._id, label: branch.name }))];
                  const departmentOptions: { value: Id<"departments"> | ""; label: string }[] = [{ value: "", label: "No department" }, ...data.departments.filter((department) => department.branchId === branchId).map((department) => ({ value: department._id, label: department.name }))];
                  return (
                    <tr key={user.membership._id} className="group/row" data-checked={isChecked ? "true" : undefined}>
                      <td><div className="flex items-center gap-2.5"><MemberAvatar name={user.user.name} email={user.user.email} /><div className="min-w-0"><div className="truncate text-[13px] font-medium text-[var(--ink)]">{user.user.name || user.user.email}</div><div className="truncate text-[12px] text-[var(--ink-muted)]">{user.user.email}</div></div></div></td>
                      <td><PeopleCellMenu value={user.membership.role} options={roles.map((role) => ({ value: role, label: role }))} onChange={(role) => { if (role !== user.membership.role) void onRoleChange(user, role); }} ariaLabel={`Change role for ${user.user.name || user.user.email}`} disabled={!canManagePermissions} renderValue={(option) => <Badge tone={roleTone[(option?.value ?? user.membership.role) as Role]}>{option?.label ?? user.membership.role}</Badge>} /></td>
                      <td><PeopleCellMenu value={branchId} options={branchOptions} onChange={(nextBranchId) => { if (nextBranchId !== branchId) void onBranchChange(user, nextBranchId); }} ariaLabel={`Change branch for ${user.user.name || user.user.email}`} disabled={!canManageUsers} /></td>
                      <td><PeopleCellMenu value={departmentId} options={departmentOptions} onChange={(nextDepartmentId) => { if (nextDepartmentId !== departmentId) void onDepartmentChange(user, nextDepartmentId); }} ariaLabel={`Change department for ${user.user.name || user.user.email}`} disabled={!canManageUsers || !branchId} placeholder={branchId ? "—" : "Select branch first"} /></td>
                      <td><PeopleCellMenu value={user.membership.active ? "active" : "paused"} options={[{ value: "active", label: "Active" }, { value: "paused", label: "Paused" }]} onChange={(status) => { const active = status === "active"; if (active !== user.membership.active) void onStatusChange(user, active); }} ariaLabel={`Change status for ${user.user.name || user.user.email}`} disabled={!canManageUsers} renderValue={(option) => <Badge tone={(option?.value ?? (user.membership.active ? "active" : "paused")) === "active" ? "green" : "neutral"}>{option?.label ?? (user.membership.active ? "Active" : "Paused")}</Badge>} /></td>
                      <td className="text-[12.5px] text-[var(--ink-secondary)]">{formatDate(user.membership.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="company-table-wrap"><table className="task-table"><thead><tr><th className="min-w-[220px]"><ColumnHeading icon={MailPlus}>Invitation</ColumnHeading></th><th className="w-28"><ColumnHeading icon={UserCog}>Role</ColumnHeading></th><th className="min-w-[120px]"><ColumnHeading icon={Building2}>Branch</ColumnHeading></th><th className="min-w-[140px]"><ColumnHeading icon={Layers}>Department</ColumnHeading></th><th className="w-28"><ColumnHeading icon={CirclePause}>Status</ColumnHeading></th><th className="w-32"><ColumnHeading icon={CalendarDays}>Invited</ColumnHeading></th></tr></thead><tbody>
          {isEmpty ? <tr><td colSpan={6} className="!h-auto !border-0 !bg-transparent py-2"><EmptyState icon={MailPlus} title={query || roleFilter !== "all" ? "No matching invitations" : "No pending invitations"} message={query || roleFilter !== "all" ? "Try adjusting your search or filters." : "Invite a person to send them a join link."} action={canInvite && !query && roleFilter === "all" ? <Button size="sm" variant="primary" onClick={onInvite}><MailPlus className="h-3.5 w-3.5" />Invite member</Button> : undefined} /></td></tr> : filteredInvitations.map((invitation) => <tr key={invitation._id} className="group/row"><td><div className="flex items-center gap-2.5"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)] text-[var(--ink-faint)]"><MailPlus className="h-3.5 w-3.5" /></span><div className="min-w-0"><div className="truncate text-[13px] font-medium text-[var(--ink)]">{invitation.email}</div><div className="truncate text-[12px] text-[var(--ink-muted)]">Pending invitation</div></div></div></td><td><Badge tone={roleTone[invitation.role]}>{invitation.role}</Badge></td><td className="text-[var(--ink-secondary)]"><span className="truncate">{invitation.branchIds.map((id) => branchMap.get(id)).filter(Boolean).join(", ") || "—"}</span></td><td className="text-[var(--ink-secondary)]"><span className="truncate">{invitation.departmentIds.map((id) => departmentMap.get(id)).filter(Boolean).join(", ") || "—"}</span></td><td><Badge tone="yellow" className="capitalize">{invitation.status}</Badge></td><td className="text-[12.5px] text-[var(--ink-secondary)]">{formatDate(invitation.createdAt)}</td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}

/* ============================================================== */
/*  Permissions tab                                                */
/* ============================================================== */

function PermissionsTab({ data, onOpenDetails, selectedMembershipId }: { data: Overview; onOpenDetails: (user: UserRow) => void; selectedMembershipId?: Id<"companyMemberships"> }) {
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
    <div className="company-tab-body company-permissions-body">
      <div className="flex flex-wrap items-center gap-2">
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
              <th className="min-w-[220px]"><ColumnHeading icon={Users}>Member</ColumnHeading></th>
              <th className="w-28"><ColumnHeading icon={UserCog}>Role</ColumnHeading></th>
              <th className="min-w-[260px]"><ColumnHeading icon={ShieldCheck}>Overrides</ColumnHeading></th>
            </tr>
          </thead>
          <tbody>
            {usersWithOverrides.length === 0 ? (
              <tr>
                <td colSpan={3} className="!h-auto !border-0 !bg-transparent py-2">
                  <EmptyState
                    icon={ShieldCheck}
                    title={query ? "No matching members" : "No manual exceptions"}
                    message={
                      query
                        ? "Try a different name or email."
                        : "Everyone follows their role defaults. Open a member's permissions drawer to add an override if needed."
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
                  <tr key={user.membership._id} data-selected={user.membership._id === selectedMembershipId ? "true" : undefined} className="group/row">
                    <td className="col-task max-w-[320px]">
                      <div className="task-title-cell">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <MemberAvatar name={user.user.name} email={user.user.email} />
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-[var(--ink)]">{user.user.name || user.user.email}</div>
                            <div className="truncate text-[12px] text-[var(--ink-muted)]">{user.user.email}</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          data-interactive="true"
                          data-tooltip="Open permissions"
                          className="task-title-open"
                          onClick={(event) => { event.stopPropagation(); onOpenDetails(user); }}
                          aria-label={`Open permissions for ${user.user.name || user.user.email}`}
                        >
                          <PanelRight className="h-3.5 w-3.5" />
                          <span>OPEN</span>
                        </button>
                      </div>
                    </td>
                    <td>
                      <Badge tone={roleTone[user.membership.role]}>{user.membership.role}</Badge>
                    </td>
                    <td className="max-w-[320px]">
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

function PermissionProperty({ icon, label, children, muted = false, className }: { icon: React.ReactNode; label: string; children: React.ReactNode; muted?: boolean; className?: string }) {
  return (
    <div className={cn("flex min-w-[74px] flex-col items-start gap-1", className)}>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold leading-4 text-[var(--ink-muted)]">
        <span className="grid h-4 w-4 place-items-center text-[var(--ink-faint)] [&_svg]:shrink-0">{icon}</span>
        {label}
      </span>
      <div className={cn("sop-detail-prop-value flex min-h-[22px] w-full min-w-0 items-center text-[13px] leading-5 text-[var(--ink)]", muted && "text-[var(--ink-faint)]")}>{children}</div>
    </div>
  );
}

function PermissionMultiSelectPopover<T extends string>({
  ariaLabel,
  empty,
  header,
  options,
  selected,
  onChange,
  disabled = false,
  children,
}: {
  ariaLabel: string;
  empty: string;
  header: React.ReactNode;
  options: { id: T; label: string; helper?: string }[];
  selected: T[];
  onChange: (ids: T[]) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const selectedSet = new Set(selected);

  function measure() {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.max(bounds.width, 260);
    const left = Math.min(Math.max(12, bounds.left), Math.max(12, window.innerWidth - width - 12));
    const below = bounds.bottom + 6;
    const above = Math.max(12, bounds.top - 326);
    const top = below + 326 > window.innerHeight && bounds.top > 326 ? above : Math.min(below, Math.max(12, window.innerHeight - 120));
    setRect({ top, left, width });
  }

  useEffect(() => {
    if (!open) return;
    measure();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  return (
    <span className="inline-flex w-full min-w-0">
      <button
        ref={triggerRef}
        type="button"
        className="prop-inline-text w-full justify-start disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        data-interactive="true"
        onClick={() => { if (!open) measure(); setOpen(!open); }}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        {children}
      </button>
      {open && rect && (
        <>
          <button type="button" aria-label="Close menu" className="task-cell-popover-backdrop" onClick={(event) => { event.stopPropagation(); setOpen(false); }} />
          <div className="task-cell-popover task-cell-popover-scroll" style={{ top: rect.top, left: rect.left, width: rect.width }} data-interactive="true" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="task-cell-popover-header">{header}</div>
            <div className="task-cell-popover-body">
              {options.length === 0 ? (
                <div className="px-2.5 py-3 text-[13px] text-[var(--ink-muted)]">{empty}</div>
              ) : (
                options.map((option) => {
                  const toggle = () => onChange(selectedSet.has(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id]);
                  return (
                    <div key={option.id} className="task-cell-popover-item">
                      <Checkbox checked={selectedSet.has(option.id)} aria-label={option.label} onCheckedChange={toggle} />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={toggle}>
                        <span className="block truncate">{option.label}</span>
                        {option.helper && <span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{option.helper}</span>}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

function PermissionGroups({
  role,
  overrides,
  onChange,
  disabled = false,
}: {
  role: Role;
  overrides: Record<Capability, Effect>;
  onChange: (next: Record<Capability, Effect>) => void;
  disabled?: boolean;
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
                  <Checkbox checked={checked} disabled={disabled} aria-label={capabilityLabels[capability]} onCheckedChange={toggle} />
                  <button type="button" className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60" disabled={disabled} onClick={toggle}>
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
  canManagePermissions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Overview;
  user?: UserRow;
  onSave: (user: UserRow, draft: PermissionDraft) => Promise<void>;
  canManagePermissions: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const [draft, setDraft] = useState<PermissionDraft>(() =>
    user
      ? draftFromUser(user)
      : { role: "Employee", branchIds: [], departmentIds: [], managedBranchIds: [], managedDepartmentIds: [], managedUserMembershipIds: [], overrides: { ...emptyOverrides } },
  );
  const [error, setError] = useState<string | null>(null);
  const saveVersionRef = useRef(0);

  useEffect(() => {
    if (open && user) {
      setDraft(draftFromUser(user));
      setError(null);
      setClosing(false);
    }
  }, [open, user]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  if (!user) return null;

  const branches = data.branches.map((branch) => ({ id: branch._id, label: branch.name }));
  const selectedBranchIds = new Set(draft.branchIds);
  const departments = data.departments
    .filter((department) => selectedBranchIds.has(department.branchId))
    .map((department) => ({
      id: department._id,
      label: department.name,
      helper: data.branches.find((branch) => branch._id === department.branchId)?.name,
    }));
  const people = data.users
    .filter((row) => row.membership._id !== user.membership._id)
    .map((row) => ({ id: row.membership._id, label: row.user.name || row.user.email, helper: row.membership.role }));
  const managedBranchIds = new Set(draft.managedBranchIds);
  const managedDepartments = data.departments
    .filter((department) => managedBranchIds.has(department.branchId))
    .map((department) => ({
      id: department._id,
      label: department.name,
      helper: data.branches.find((branch) => branch._id === department.branchId)?.name,
    }));
  const branchNames = draft.branchIds
    .map((branchId) => data.branches.find((branch) => branch._id === branchId)?.name)
    .filter((name): name is string => Boolean(name));
  const departmentNames = draft.departmentIds
    .map((departmentId) => data.departments.find((department) => department._id === departmentId)?.name)
    .filter((name): name is string => Boolean(name));
  const branchText = branchNames.length === 0 ? "No branch" : branchNames.length === 1 ? branchNames[0] : `${branchNames.length} branches`;
  const departmentText = draft.branchIds.length === 0 ? "Select branch first" : departmentNames.length === 0 ? "No department" : departmentNames.length === 1 ? departmentNames[0] : `${departmentNames.length} departments`;

  function closePermissions() {
    if (closing) return;
    setClosing(true);
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onOpenChange(false);
      setClosing(false);
    }, DETAIL_DRAWER_CLOSE_MS);
  }

  function updateDraft(next: PermissionDraft) {
    setDraft(next);
    if (!canManagePermissions) return;
    const version = ++saveVersionRef.current;
    setError(null);
    void onSave(user!, next).catch((err) => {
      if (version === saveVersionRef.current) setError(err instanceof Error ? err.message : "Could not save permissions.");
    });
  }

  function updateBranches(branchIds: Id<"branches">[]) {
    const branchSet = new Set(branchIds);
    updateDraft({
      ...draft,
      branchIds,
      departmentIds: draft.departmentIds.filter((departmentId) => {
        const department = data.departments.find((item) => item._id === departmentId);
        return Boolean(department && branchSet.has(department.branchId));
      }),
    });
  }

  function updateManagedBranches(managedBranchIds: Id<"branches">[]) {
    const branchSet = new Set(managedBranchIds);
    updateDraft({
      ...draft,
      managedBranchIds,
      managedDepartmentIds: draft.managedDepartmentIds.filter((departmentId) => {
        const department = data.departments.find((item) => item._id === departmentId);
        return Boolean(department && branchSet.has(department.branchId));
      }),
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (nextOpen) onOpenChange(true); else closePermissions(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-transparent" />
        <Dialog.Content asChild>
          <motion.aside
            className="task-drawer !fixed"
            initial={reduceMotion ? { opacity: 0 } : { x: 32, opacity: 0 }}
            animate={closing ? (reduceMotion ? { opacity: 0 } : { x: 32, opacity: 0 }) : (reduceMotion ? { opacity: 1 } : { x: 0, opacity: 1 })}
            transition={reduceMotion ? { duration: 0.1 } : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="task-drawer-inner">
              <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col px-6 py-7 md:px-9 md:py-8">
                <div className="peek-bar -mt-7 -mx-6 px-2 md:-mt-8 md:-mx-9 md:px-3">
                  <button type="button" className="task-icon-btn" aria-label="Close permissions" onClick={closePermissions}>
                    <ChevronsRight className="h-5 w-5" />
                  </button>
                </div>

                <div className="pt-6">
                  <Dialog.Title className="text-[26px] font-bold leading-tight tracking-[-0.025em] text-[var(--ink)]">Permissions</Dialog.Title>
                  <Dialog.Description className="sr-only">Manage permissions for {user.user.name || user.user.email}</Dialog.Description>
                </div>

                <section className="task-section !mt-8">
                  <div className="prop-list">
                    <div className="prop-row">
                      <span className="prop-label"><UserCog className="h-3.5 w-3.5" />Role</span>
                      <div className="prop-value">
                        <PeopleCellMenu value={draft.role} options={roles.map((role) => ({ value: role, label: role }))} onChange={(role) => updateDraft({ ...draft, role })} ariaLabel={`Change role for ${user.user.name || user.user.email}`} disabled={!canManagePermissions} renderValue={(option) => <Badge tone={roleTone[(option?.value ?? draft.role) as Role]}>{option?.label ?? draft.role}</Badge>} />
                      </div>
                    </div>
                    <div className="prop-row">
                      <span className="prop-label"><Building2 className="h-3.5 w-3.5" />Branch</span>
                      <div className="prop-value truncate">
                        <PermissionMultiSelectPopover ariaLabel="Change branches" empty="No branches" header={<span className="min-w-0 flex-1 truncate">Branches</span>} options={branches} selected={draft.branchIds} disabled={!canManagePermissions} onChange={updateBranches}>
                          <span className="truncate">{branchText}</span>
                        </PermissionMultiSelectPopover>
                      </div>
                    </div>
                    <div className="prop-row">
                      <span className="prop-label"><Layers className="h-3.5 w-3.5" />Department</span>
                      <div className={cn("prop-value truncate", draft.departmentIds.length === 0 && "prop-value--muted")}>
                        <PermissionMultiSelectPopover ariaLabel="Change departments" empty="No departments in selected branches" header={<span className="min-w-0 flex-1 truncate">Departments</span>} options={departments} selected={draft.departmentIds} disabled={!canManagePermissions || draft.branchIds.length === 0} onChange={(departmentIds) => updateDraft({ ...draft, departmentIds })}>
                          <span className="truncate">{departmentText}</span>
                        </PermissionMultiSelectPopover>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="task-section">
                  <h2 className="task-section-title">Managed scope</h2>
                  <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                    <PermissionProperty icon={<Users className="h-3.5 w-3.5" />} label="People" className="min-w-[120px]">
                      <PermissionMultiSelectPopover ariaLabel="Change people under this user" empty="No other people" header={<span className="min-w-0 flex-1 truncate">People under this user</span>} options={people} selected={draft.managedUserMembershipIds} disabled={!canManagePermissions} onChange={(managedUserMembershipIds) => updateDraft({ ...draft, managedUserMembershipIds })}>
                        <span className="block w-full rounded-md py-1 text-[20px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{draft.managedUserMembershipIds.length}</span>
                      </PermissionMultiSelectPopover>
                    </PermissionProperty>
                    <PermissionProperty icon={<Building2 className="h-3.5 w-3.5" />} label="Branches" className="min-w-[120px]">
                      <PermissionMultiSelectPopover ariaLabel="Change branches under this user" empty="No branches" header={<span className="min-w-0 flex-1 truncate">Branches under this user</span>} options={branches} selected={draft.managedBranchIds} disabled={!canManagePermissions} onChange={updateManagedBranches}>
                        <span className="block w-full rounded-md py-1 text-[20px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{draft.managedBranchIds.length}</span>
                      </PermissionMultiSelectPopover>
                    </PermissionProperty>
                    <PermissionProperty icon={<Layers className="h-3.5 w-3.5" />} label="Departments" muted={draft.managedDepartmentIds.length === 0} className="min-w-[120px]">
                      <PermissionMultiSelectPopover ariaLabel="Change departments under this user" empty="No departments in selected branches" header={<span className="min-w-0 flex-1 truncate">Departments under this user</span>} options={managedDepartments} selected={draft.managedDepartmentIds} disabled={!canManagePermissions || draft.managedBranchIds.length === 0} onChange={(managedDepartmentIds) => updateDraft({ ...draft, managedDepartmentIds })}>
                        <span className="block w-full rounded-md py-1 text-[20px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{draft.managedDepartmentIds.length}</span>
                      </PermissionMultiSelectPopover>
                    </PermissionProperty>
                  </div>
                </section>

                <section className="task-section !mt-10">
                  <PermissionGroups role={draft.role} overrides={draft.overrides} disabled={!canManagePermissions} onChange={(overrides) => updateDraft({ ...draft, overrides })} />
                </section>

                {error && (
                  <p className="alert-error mt-5 rounded-md px-3 py-2 text-[12.5px]" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </div>
          </motion.aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ============================================================== */
/*  Sidebar nav                                                    */
/* ============================================================== */

function CompanySidebar({ tab, setTab, tabs }: { tab: TabValue; setTab: (value: TabValue) => void; tabs: typeof TABS }) {
  return (
    <aside className="company-nav" aria-label="Company management sections">
      <nav className="company-nav-list" role="tablist" aria-label="Company settings">
        {tabs.map((item) => {
          const Icon = item.icon;
          const isActive = tab === item.value;
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
  const updateCompanyName = useMutation(api.companyManagement.updateCompanyName).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (current) {
      localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
        ...current,
        company: current.company ? { ...current.company, name: args.name } : current.company,
      } as any);
    }
    const access = localStore.getQuery(api.companies.accessStatus, {}) as any;
    if (access?.status === "ready") {
      localStore.setQuery(api.companies.accessStatus, {}, {
        ...access,
        companies: access.companies.map((row: any) => row.company._id === args.companyId ? { ...row, company: { ...row.company, name: args.name } } : row),
      });
    }
  });
  const updateCompanyTimeZone = useMutation(api.companyManagement.updateCompanyTimeZone).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (current) {
      localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
        ...current,
        company: current.company ? { ...current.company, timeZone: args.timeZone, hasTimeZone: true } : current.company,
      } as any);
    }
    const access = localStore.getQuery(api.companies.accessStatus, {}) as any;
    if (access?.status === "ready") {
      localStore.setQuery(api.companies.accessStatus, {}, {
        ...access,
        companies: access.companies.map((row: any) => row.company._id === args.companyId ? { ...row, company: { ...row.company, timeZone: args.timeZone } } : row),
      });
    }
  });
  const createBranch = useMutation(api.companyManagement.createBranch);
  const createDepartment = useMutation(api.companyManagement.createDepartment);
  const deleteBranch = useMutation(api.companyManagement.deleteBranch);
  const deleteDepartment = useMutation(api.companyManagement.deleteDepartment);
  const reorderBranches = useMutation(api.companyManagement.reorderBranches);
  const moveDepartment = useMutation(api.companyManagement.moveDepartment);
  const invite = useAction(api.companyManagement.inviteUser);
  const setUserRole = useMutation(api.companyManagement.setUserRole).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => row.membership._id === args.membershipId ? { ...row, membership: { ...row.membership, role: args.role }, overrides: [] } : row),
    } as any);
  });
  const setAssignments = useMutation(api.companyManagement.setAssignments).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => row.membership._id === args.membershipId ? { ...row, branchIds: args.branchIds, departmentIds: args.departmentIds } : row),
    } as any);
  });
  const setUserActive = useMutation(api.companyManagement.setUserActive).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => row.membership._id === args.membershipId ? { ...row, membership: { ...row.membership, active: args.active } } : row),
    } as any);
  });
  const removeUsers = useMutation(api.companyManagement.removeUsers).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    const removing = new Set(args.membershipIds);
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => removing.has(row.membership._id) ? { ...row, membership: { ...row.membership, active: false }, branchIds: [], departmentIds: [], scope: { branchIds: [], departmentIds: [], userMembershipIds: [] }, overrides: [] } : row),
    } as any);
  });
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
  const [companyTimeZone, setCompanyTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [savingName, setSavingName] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [permissionsMembershipId, setPermissionsMembershipId] = useState<Id<"companyMemberships"> | undefined>();
  const [error, setError] = useState<string | null>(null);
  const autoTimeZoneAttempts = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (data) {
      setCompanyName(data.company?.name ?? active?.company.name ?? "");
      setCompanyTimeZone(data.company?.timeZone ?? active?.company.timeZone ?? DEFAULT_TIME_ZONE);
    }
  }, [active?.company.name, active?.company.timeZone, data]);

  const permissionsUser = useMemo(() => data?.users.find((user) => user.membership._id === permissionsMembershipId), [data?.users, permissionsMembershipId]);
  const visibleTabs = useMemo(() => TABS.filter((item) => canViewCompanyTab(item.value, active?.capabilities)), [active?.capabilities]);

  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some((item) => item.value === tab)) setTab(visibleTabs[0].value);
  }, [tab, visibleTabs]);

  useEffect(() => {
    if (!activeCompanyId || !data?.company || data.company.hasTimeZone || !active?.capabilities.includes("company:manage_settings")) return;
    const detected = browserTimeZone();
    const attemptKey = `${activeCompanyId}:${detected}`;
    if (autoTimeZoneAttempts.current.has(attemptKey)) return;
    autoTimeZoneAttempts.current.add(attemptKey);
    setCompanyTimeZone(detected);
    void updateCompanyTimeZone({ companyId: activeCompanyId, timeZone: detected }).catch((err) => {
      console.error("Could not auto-detect company time zone.", err);
      setError(err instanceof Error ? err.message : "Could not auto-detect company time zone.");
    });
  }, [active?.capabilities, activeCompanyId, data?.company, updateCompanyTimeZone]);

  if (!data) return <CompanySkeleton />;
  if (!canAccessCompanyManagement(active?.capabilities) || visibleTabs.length === 0) return <EmptyState icon={Building2} title="No company management access" message="Ask an admin to grant access to a company management section." />;

  const currentCompany = data.company ?? active?.company;
  const nameDirty = companyName.trim() !== (currentCompany?.name ?? "") && companyName.trim() !== "";
  const canManageSettings = active?.capabilities.includes("company:manage_settings") ?? false;
  const canManageBranches = active?.capabilities.includes("company:manage_branches") ?? false;
  const canManageDepartments = active?.capabilities.includes("company:manage_departments") ?? false;
  const canManageUsers = active?.capabilities.includes("company:manage_users") ?? false;
  const canManagePermissions = active?.capabilities.includes("company:manage_permissions") ?? false;
  const canInvite = active?.capabilities.includes("company:invite_users") ?? false;
  const activeTab = visibleTabs.some((item) => item.value === tab) ? tab : visibleTabs[0].value;

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

  async function saveCompanyTimeZone(timeZone: string) {
    if (!activeCompanyId || timeZone === currentCompany?.timeZone) return;
    setSavingTimeZone(true);
    try {
      await updateCompanyTimeZone({ companyId: activeCompanyId, timeZone });
    } catch (err) {
      setCompanyTimeZone(currentCompany?.timeZone ?? DEFAULT_TIME_ZONE);
      setError(err instanceof Error ? err.message : "Could not update the time zone.");
    } finally {
      setSavingTimeZone(false);
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

  async function changeUserRole(user: UserRow, role: Role) {
    if (!activeCompanyId) return;
    await setUserRole({ companyId: activeCompanyId, membershipId: user.membership._id, role });
  }

  async function changeUserBranch(user: UserRow, branchId: Id<"branches"> | "") {
    if (!activeCompanyId || !data) return;
    const departmentIds = user.departmentIds.filter((departmentId) => {
      const department = data.departments.find((item) => item._id === departmentId);
      return Boolean(branchId && department?.branchId === branchId);
    });
    await setAssignments({ companyId: activeCompanyId, membershipId: user.membership._id, branchIds: branchId ? [branchId] : [], departmentIds });
  }

  async function changeUserDepartment(user: UserRow, departmentId: Id<"departments"> | "") {
    if (!activeCompanyId) return;
    const branchId = user.branchIds[0];
    if (!branchId) return;
    await setAssignments({ companyId: activeCompanyId, membershipId: user.membership._id, branchIds: [branchId], departmentIds: departmentId ? [departmentId] : [] });
  }

  async function changeUserStatus(user: UserRow, active: boolean) {
    if (!activeCompanyId) return;
    await setUserActive({ companyId: activeCompanyId, membershipId: user.membership._id, active });
  }

  async function removeSelectedUsers(membershipIds: Id<"companyMemberships">[]) {
    if (!activeCompanyId || membershipIds.length === 0) return;
    await removeUsers({ companyId: activeCompanyId, membershipIds });
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
          <CompanySidebar tab={activeTab} setTab={setTab} tabs={visibleTabs} />
        </div>
        <main className="company-main">
          <CompanyContentHeader tab={activeTab} />

          <div className="company-main-body">
            {activeTab === "general" && (
              <GeneralTab
                data={data}
                companyName={companyName}
                setCompanyName={setCompanyName}
                timeZone={companyTimeZone}
                setTimeZone={setCompanyTimeZone}
                savingTimeZone={savingTimeZone}
                nameDirty={nameDirty}
                savingName={savingName}
                canManageSettings={canManageSettings}
                onSaveName={saveCompanyName}
                onSaveTimeZone={saveCompanyTimeZone}
              />
            )}
            {activeTab === "structure" && (
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
                onReorderBranches={async (orderedBranchIds) => {
                  if (!activeCompanyId) return;
                  setError(null);
                  try { await reorderBranches({ companyId: activeCompanyId, orderedBranchIds }); }
                  catch (err) { setError(err instanceof Error ? err.message : "Could not reorder branches."); throw err; }
                }}
                onMoveDepartment={async (departmentId, toBranchId, orderedDepartmentIds) => {
                  if (!activeCompanyId) return;
                  setError(null);
                  try { await moveDepartment({ companyId: activeCompanyId, departmentId, toBranchId, orderedDepartmentIds }); }
                  catch (err) { setError(err instanceof Error ? err.message : "Could not move department."); throw err; }
                }}
              />
            )}
            {activeTab === "people" && (
              <PeopleTab
                data={data}
                onInvite={() => setInviteOpen(true)}
                onRoleChange={(user, role) => run(() => changeUserRole(user, role), "Could not update role.")}
                onBranchChange={(user, branchId) => run(() => changeUserBranch(user, branchId), "Could not update branch.")}
                onDepartmentChange={(user, departmentId) => run(() => changeUserDepartment(user, departmentId), "Could not update department.")}
                onStatusChange={(user, active) => run(() => changeUserStatus(user, active), "Could not update status.")}
                onRemoveUsers={removeSelectedUsers}
                canManageUsers={canManageUsers}
                canManagePermissions={canManagePermissions}
                canInvite={canInvite}
              />
            )}
            {activeTab === "permissions" && <PermissionsTab data={data} selectedMembershipId={permissionsMembershipId} onOpenDetails={(user) => setPermissionsMembershipId(user.membership._id)} />}
          </div>
        </main>
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} data={data} onInvite={inviteMember} />
      <PermissionsDialog open={Boolean(permissionsMembershipId)} onOpenChange={(open) => !open && setPermissionsMembershipId(undefined)} data={data} user={permissionsUser} onSave={savePermissions} canManagePermissions={canManagePermissions} />
    </div>
  );
}
