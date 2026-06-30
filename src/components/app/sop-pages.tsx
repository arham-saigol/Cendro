"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  FileText,
  History,
  Inbox,
  Layers,
  PanelRight,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQuery_experimental } from "convex/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "./company-context";
import { requestDetailDrawerClose } from "./detail-drawer-motion";
import { PageHeader } from "./page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SopRichTextEditor, SopRichTextViewer, richTextPlainText } from "./sop-rich-text";
import { cn, formatDate, initials } from "@/lib/utils";

type ScopeType = "company" | "branch" | "department" | "user";
type EditableScopeType = "company" | "branch" | "department" | "user";
type CreateScopeType = EditableScopeType;
type SopView = "all" | "my";
type SopScopeFilter = "all" | ScopeType;
type SopScopeOptions = { branches: { _id: Id<"branches">; name: string }[]; departments: { _id: Id<"departments">; name: string; branchId: Id<"branches">; branchName?: string }[]; users: { membership: { _id: Id<"companyMemberships">; role: string }; user: { name: string; firstName?: string; imageUrl?: string | null } }[] };
type SopTargetUser = { firstName?: string; name?: string; imageUrl?: string | null } | null | undefined;

const editableScopeTypes: EditableScopeType[] = ["company", "branch", "department", "user"];

const scopeLabels: Record<ScopeType, string> = {
  company: "Company",
  branch: "Branch",
  department: "Department",
  user: "User",
};

const toneClasses: Record<string, string> = {
  blue: "bg-[var(--badge-blue-bg)] text-[var(--badge-blue-fg)]",
  green: "bg-[var(--badge-green-bg)] text-[var(--badge-green-fg)]",
  yellow: "bg-[var(--badge-yellow-bg)] text-[var(--badge-yellow-fg)]",
  neutral: "bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-fg)]",
  proposal: "bg-[#f0dfbc] text-[#6b552d]",
};

function scopeTone(scopeType: ScopeType): string {
  if (scopeType === "company") return "blue";
  if (scopeType === "branch") return "green";
  if (scopeType === "department") return "yellow";
  return "proposal";
}

function canManageSop(active: { capabilities: string[] } | null | undefined, scopeType: ScopeType) {
  return active?.capabilities.includes(`sops:manage:${scopeType}`) ?? false;
}
function canCreateSops(active: { capabilities: string[] } | null | undefined) {
  return Boolean(active?.capabilities.includes("sops:create") && editableScopeTypes.some((scope) => active.capabilities.includes(`sops:manage:${scope}`)));
}
function canLoadSopScopeOptions(active: { capabilities: string[] } | null | undefined) {
  return Boolean(active?.capabilities.some((capability) => capability === "sops:manage:branch" || capability === "sops:manage:department" || capability === "sops:manage:user"));
}

function relativeTime(ms?: number) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = 60_000, hr = 3_600_000, day = 86_400_000;
  if (diff < 0) return "just now";
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return formatDate(ms);
}

function useDebouncedValue<T>(value: T, delay = 220): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function autoSize(ref: React.RefObject<HTMLTextAreaElement | null>) {
  const el = ref.current;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function ScopePill({ scopeType, size = "sm" }: { scopeType: ScopeType; size?: "sm" | "md" }) {
  return (
    <span className={cn("sop-scope-pill", toneClasses[scopeTone(scopeType)], size === "md" && "sop-scope-pill-md")}>
      {scopeLabels[scopeType]}
    </span>
  );
}

function DialogSelectPicker<T extends string>({ ariaLabel, value, options, onChange, placeholder = "Select", disabled = false }: { ariaLabel: string; value: T | ""; options: { value: T; label: string; helper?: string }[]; onChange: (value: T) => void; placeholder?: string; disabled?: boolean }) {
  const selectedOption = options.find((option) => option.value === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-inline-control" data-interactive="true" disabled={disabled} onClick={(event) => event.stopPropagation()}>
          <span className={cn("truncate", !selectedOption && "text-[var(--ink-faint)]")}>{selectedOption?.label ?? placeholder}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="task-menu w-[var(--radix-dropdown-menu-trigger-width)]" aria-label={ariaLabel} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          {options.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => onChange(option.value)} className="task-menu-item">
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-[var(--ink)]">{option.label}</span>
                {option.helper && <span className="block text-[11.5px] text-[var(--ink-muted)]">{option.helper}</span>}
              </span>
              {value === option.value && <Check className="h-4 w-4 shrink-0 text-[var(--primary)]" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function sopTargetName(sop: any, companyName?: string) {
  if (typeof sop.scopeTargetName === "string" && sop.scopeTargetName.trim()) return sop.scopeTargetName;
  if (sop.scopeType === "company") return companyName ?? "Company";
  if (sop.scopeType === "branch") return "Unknown branch";
  if (sop.scopeType === "department") return "Unknown department";
  return "Unknown user";
}

function firstDisplayName(user: SopTargetUser, fallback: string) {
  const first = user?.firstName?.trim();
  if (first) return first;
  return fallback.trim().split(/\s+/)[0] || fallback;
}

function valuesMatch(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => valuesMatch(item, b[index]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const keys = Object.keys(aRecord);
    return keys.length === Object.keys(bRecord).length && keys.every((key) => valuesMatch(aRecord[key], bRecord[key]));
  }
  return false;
}

function patchMatches(row: any, patch: Record<string, unknown>) {
  return Object.entries(patch).every(([key, value]) => valuesMatch(row[key], value));
}

function SopUserAvatar({ name, imageUrl }: { name: string; imageUrl?: string | null }) {
  return (
    <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,var(--surface-hover),var(--surface-pressed))] text-[9.5px] font-semibold text-[var(--ink-secondary)] ring-1 ring-[var(--canvas)]" title={name}>
      {initials(name)}
      {imageUrl && <span aria-hidden="true" className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${imageUrl})` }} />}
    </span>
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M234.29,114.85l-45,38.83L203,211.75a16.4,16.4,0,0,1-24.5,17.82L128,198.49,77.47,229.57A16.4,16.4,0,0,1,53,211.75l13.76-58.07-45-38.83A16.46,16.46,0,0,1,31.08,86l59-4.76,22.76-55.08a16.36,16.36,0,0,1,30.27,0l22.75,55.08,59,4.76a16.46,16.46,0,0,1,9.37,28.86Z" />
    </svg>
  );
}

function SopFilterSubmenu<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; avatar?: React.ReactNode }[]; onChange: (value: T) => void }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="task-menu-item">
        <span className="flex-1">{label}</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={7} alignOffset={-5} className="task-menu min-w-52">
          {options.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => onChange(option.value)} className="task-menu-item">
              {option.avatar}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {value === option.value && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function SopFilterMenu({
  scopeFilter,
  branchFilter,
  personFilter,
  branches,
  users,
  activeCount,
  showPersonFilter,
  onScopeChange,
  onBranchChange,
  onPersonChange,
}: {
  scopeFilter: SopScopeFilter;
  branchFilter: string;
  personFilter: string;
  branches: SopScopeOptions["branches"];
  users: SopScopeOptions["users"];
  activeCount: number;
  showPersonFilter: boolean;
  onScopeChange: (value: SopScopeFilter) => void;
  onBranchChange: (value: string) => void;
  onPersonChange: (value: string) => void;
}) {
  const scopeOptions: { value: SopScopeFilter; label: string }[] = [{ value: "all", label: "All scopes" }, ...(["company", "branch", "department", "user"] as ScopeType[]).map((scope) => ({ value: scope, label: scopeLabels[scope] }))];
  const branchOptions = [{ value: "all", label: "All branches" }, ...branches.map((branch) => ({ value: branch._id as string, label: branch.name }))];
  const personOptions = [{ value: "all", label: "All people" }, ...users.map((user) => ({ value: user.membership._id as string, label: user.user.name, avatar: <SopUserAvatar name={user.user.name} imageUrl={user.user.imageUrl} /> }))];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-toolbar-icon" data-active={activeCount > 0} aria-label="Filter SOPs">
          <SlidersHorizontal className="h-4 w-4" />
          {activeCount > 0 && <span className="task-toolbar-badge">{activeCount}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="task-menu min-w-48" aria-label="SOP filters">
          <SopFilterSubmenu label="Scope" value={scopeFilter} options={scopeOptions} onChange={onScopeChange} />
          <SopFilterSubmenu label="Branch" value={branchFilter} options={branchOptions} onChange={onBranchChange} />
          {showPersonFilter && <SopFilterSubmenu label="Person" value={personFilter} options={personOptions} onChange={onPersonChange} />}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SopTargetValue({ scopeType, targetName, user }: { scopeType: ScopeType; targetName: string; user?: SopTargetUser }) {
  if (scopeType !== "user") return <span className="block truncate" title={targetName}>{targetName}</span>;
  const displayName = firstDisplayName(user, targetName);
  const avatarName = user?.name?.trim() || targetName;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={avatarName}>
      <SopUserAvatar name={avatarName} imageUrl={user?.imageUrl} />
      <span className="min-w-0 truncate">{displayName}</span>
    </span>
  );
}

function SopDialog({
  mode,
  open,
  onOpenChange,
  sop,
  onCreated,
}: {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sop?: any;
  onCreated?: (id: string) => void;
}) {
  const { activeCompanyId, active } = useCompany();
  const create = useMutation(api.sops.create);
  const update = useMutation(api.sops.update);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [scopeType, setScopeType] = useState<CreateScopeType>("company");
  const [branchId, setBranchId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [userMembershipId, setUserMembershipId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const createScopes = useMemo<CreateScopeType[]>(() => active?.capabilities.includes("sops:create") ? [
    ...(active.capabilities.includes("sops:manage:company") ? ["company" as const] : []),
    ...(active.capabilities.includes("sops:manage:branch") ? ["branch" as const] : []),
    ...(active.capabilities.includes("sops:manage:department") ? ["department" as const] : []),
    ...(active.capabilities.includes("sops:manage:user") ? ["user" as const] : []),
  ] : [], [active]);
  const defaultCreateScope = createScopes[0] ?? "company";
  const canSelectCreateTarget = createScopes.some((scope) => scope !== "company");
  const scopeOptions = useQuery(api.sops.scopeOptions, mode === "create" && open && activeCompanyId && canSelectCreateTarget ? { companyId: activeCompanyId } : "skip") as SopScopeOptions | undefined;
  const scopeTargetValid = mode !== "create" || scopeType === "company" || (scopeType === "branch" ? Boolean(branchId) : scopeType === "department" ? Boolean(departmentId) : Boolean(userMembershipId));

  useEffect(() => {
    if (!open) return;
    setTitle(sop?.title ?? "");
    setContent(sop?.content ?? "");
    if (mode === "create") {
      setScopeType(defaultCreateScope);
      setBranchId("");
      setDepartmentId("");
      setUserMembershipId("");
    }
    setError(null);
    setSaving(false);
  }, [open, sop, mode, defaultCreateScope]);

  useEffect(() => {
    if (mode !== "create" || !open) return;
    if (!createScopes.includes(scopeType)) setScopeType(defaultCreateScope);
  }, [createScopes, defaultCreateScope, mode, open, scopeType]);

  useEffect(() => {
    if (mode !== "create" || !open || !scopeOptions) return;
    if (scopeType === "branch" && !scopeOptions.branches.some((branch) => branch._id === branchId)) setBranchId(scopeOptions.branches[0]?._id ?? "");
    if (scopeType === "department" && !scopeOptions.departments.some((department) => department._id === departmentId)) setDepartmentId(scopeOptions.departments[0]?._id ?? "");
    if (scopeType === "user" && !scopeOptions.users.some((user) => user.membership._id === userMembershipId)) setUserMembershipId(scopeOptions.users[0]?.membership._id ?? "");
  }, [branchId, departmentId, mode, open, scopeOptions, scopeType, userMembershipId]);

  useEffect(() => autoSize(titleRef), [title, open]);

  const contentPlainText = richTextPlainText(content);

  async function submit() {
    if (!activeCompanyId || saving) return;
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (!trimmedTitle) { setError("Title is required."); return; }
    if (!richTextPlainText(trimmedContent)) { setError("SOP body is required."); return; }
    if (mode === "create" && scopeType === "branch" && !branchId) { setError("Select a branch for this SOP."); return; }
    if (mode === "create" && scopeType === "department" && !departmentId) { setError("Select a department for this SOP."); return; }
    if (mode === "create" && scopeType === "user" && !userMembershipId) { setError("Select a user for this SOP."); return; }
    setSaving(true);
    setError(null);
    try {
      if (mode === "create") {
        const id = await create({
          companyId: activeCompanyId,
          title: trimmedTitle,
          content: trimmedContent,
          scopeType,
          branchIds: scopeType === "branch" ? [branchId as Id<"branches">] : [],
          departmentIds: scopeType === "department" ? [departmentId as Id<"departments">] : [],
          userMembershipIds: scopeType === "user" ? [userMembershipId as Id<"companyMemberships">] : [],
        });
        if (scopeType === "company" || (scopeType === "user" && userMembershipId === active?.membership._id)) onCreated?.(id as unknown as string);
      } else {
        await update({ companyId: activeCompanyId, sopId: sop._id as Id<"sops">, title: trimmedTitle, content: trimmedContent });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the SOP.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(820px,94dvh)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--hairline)] px-6 py-4">
            <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{mode === "create" ? "New SOP" : "Edit SOP"}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="task-icon-btn" aria-label="Close"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{mode === "create" ? "Create a standard operating procedure." : "Edit this standard operating procedure."}</Dialog.Description>

          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <textarea
                ref={titleRef}
                aria-label="SOP title"
                className="w-full resize-none overflow-hidden border-none bg-transparent text-lg font-semibold tracking-[-0.01em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
                rows={1}
                value={title}
                onChange={(event) => { setTitle(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
                placeholder="Untitled procedure"
                autoFocus
              />

              <div className="mt-4 divide-y divide-[var(--hairline)] border-y border-[var(--hairline)]">
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                  <span className="text-[13px] text-[var(--ink-muted)]">Scope</span>
                  {mode === "create" ? (
                    <div className="min-w-0">
                      <DialogSelectPicker
                        ariaLabel="SOP scope"
                        value={scopeType}
                        options={createScopes.map((scope) => ({ value: scope, label: scopeLabels[scope] }))}
                        onChange={(value) => { setScopeType(value); setError(null); }}
                      />
                    </div>
                  ) : (
                    <div className="min-w-0"><ScopePill scopeType={sop?.scopeType ?? "company"} /></div>
                  )}
                </div>
                {mode === "create" && scopeType !== "company" && (
                  <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                    <span className="text-[13px] text-[var(--ink-muted)]">Assigned to</span>
                    <div className="min-w-0">
                      {scopeType === "branch" ? (
                        <DialogSelectPicker
                          ariaLabel="Assign SOP to branch"
                          value={branchId}
                          options={scopeOptions?.branches.map((branch) => ({ value: branch._id as string, label: branch.name })) ?? []}
                          onChange={(value) => { setBranchId(value); setError(null); }}
                          placeholder={scopeOptions ? "No branches available" : "Loading branches..."}
                          disabled={!scopeOptions?.branches.length}
                        />
                      ) : scopeType === "department" ? (
                        <DialogSelectPicker
                          ariaLabel="Assign SOP to department"
                          value={departmentId}
                          options={scopeOptions?.departments.map((department) => ({ value: department._id as string, label: department.name, helper: department.branchName })) ?? []}
                          onChange={(value) => { setDepartmentId(value); setError(null); }}
                          placeholder={scopeOptions ? "No departments available" : "Loading departments..."}
                          disabled={!scopeOptions?.departments.length}
                        />
                      ) : (
                        <DialogSelectPicker
                          ariaLabel="Assign SOP to user"
                          value={userMembershipId}
                          options={scopeOptions?.users.map((user) => ({ value: user.membership._id as string, label: user.user.name, helper: user.membership.role })) ?? []}
                          onChange={(value) => { setUserMembershipId(value); setError(null); }}
                          placeholder={scopeOptions ? "No users available" : "Loading users..."}
                          disabled={!scopeOptions?.users.length}
                        />
                      )}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-[120px_1fr] items-start gap-3 py-2">
                  <span className="pt-2 text-[13px] text-[var(--ink-muted)]">Body</span>
                  <div className="min-w-0">
                    <SopRichTextEditor
                      value={content}
                      placeholder="Write the procedure steps..."
                      ariaLabel="SOP body"
                      className="min-h-[176px] px-2 py-2 text-[13px] leading-6"
                      onChange={(value) => { setContent(value); setError(null); }}
                    />
                  </div>
                </div>
              </div>

              {error && <p className="alert-error mt-4 rounded-md px-3 py-2 text-[13px]" role="alert">{error}</p>}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--hairline)] px-6 py-4">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" size="lg" variant="primary" disabled={saving || !title.trim() || !contentPlainText || !scopeTargetValid}>{saving ? "Saving..." : mode === "create" ? "Create SOP" : "Save changes"}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InlineTitleCell({ value, ariaLabel, pending, onSave }: { value: string; ariaLabel: string; pending?: boolean; onSave: (value: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const savingRef = useRef(false);
  const didFocusRef = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [editing, value]);
  useEffect(() => { if (!editing) didFocusRef.current = false; }, [editing]);
  useLayoutEffect(() => { if (editing) autoSize(ref); }, [draft, editing]);

  async function commit() {
    if (savingRef.current) return;
    const next = draft.trim();
    if (!next) { setDraft(value); setEditing(false); return; }
    if (next === value.trim()) { setEditing(false); return; }
    savingRef.current = true;
    const ok = await onSave(next);
    savingRef.current = false;
    if (ok) setEditing(false);
    else setDraft(value);
  }

  if (editing) {
    return (
      <span className="task-cell-editor" data-interactive="true">
        <span aria-hidden="true" className="task-cell-control task-cell-editor-sizer">
          <span className="min-w-0 truncate">{value || ariaLabel}</span>
        </span>
        <textarea
          ref={ref}
          aria-label={ariaLabel}
          autoFocus
          data-interactive="true"
          disabled={pending}
          rows={1}
          value={draft}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onFocus={(event) => {
            if (didFocusRef.current) return;
            const position = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(position, position);
            didFocusRef.current = true;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === "Escape") { setDraft(value); setEditing(false); }
          }}
          className="task-cell-input sop-title-cell-input"
        />
      </span>
    );
  }

  return (
    <button
      type="button"
      data-interactive="true"
      disabled={pending}
      className={cn("task-cell-control", pending && "opacity-60")}
      onClick={(event) => { event.stopPropagation(); setEditing(true); }}
    >
      <span className={cn("min-w-0 truncate", !value && "text-[var(--ink-faint)]")}>{value || ariaLabel}</span>
    </button>
  );
}

function SopCellPopover({
  open,
  onOpenChange,
  disabled = false,
  pending = false,
  ariaLabel,
  header,
  children,
  panelClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
  ariaLabel: string;
  header: React.ReactNode;
  children: React.ReactNode;
  panelClassName?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  function measure() {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setRect({ top: bounds.top, left: bounds.left - 14, width: Math.max(bounds.width + 28, 220) });
  }

  useEffect(() => {
    if (!open) return;
    measure();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [onOpenChange, open]);

  return (
    <span className="task-cell-popover-root">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || pending}
        data-interactive="true"
        data-cell-popover-open={open ? "true" : undefined}
        onClick={(event) => { event.stopPropagation(); if (!open) measure(); onOpenChange(!open); }}
        className={cn("task-cell-control", pending && "opacity-60")}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        {header}
      </button>
      {open && rect && (
        <>
          <button type="button" aria-label="Close menu" className="task-cell-popover-backdrop" onClick={(event) => { event.stopPropagation(); onOpenChange(false); }} />
          <div className={cn("task-cell-popover", panelClassName)} style={{ top: rect.top, left: rect.left, width: rect.width }} data-interactive="true" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="task-cell-popover-header">{header}</div>
            <div className="task-cell-popover-body">{children}</div>
          </div>
        </>
      )}
    </span>
  );
}

function InlineScopeCell({ value, options, pending, onSave }: { value: EditableScopeType; options: EditableScopeType[]; pending?: boolean; onSave: (value: EditableScopeType) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const header = <span className="min-w-0 flex-1 truncate"><ScopePill scopeType={value} /></span>;
  return (
    <SopCellPopover open={open} onOpenChange={setOpen} disabled={pending || options.length === 0} pending={pending} ariaLabel="Change SOP scope" header={header}>
      {options.map((option) => (
        <button key={option} type="button" onClick={() => { setOpen(false); if (option !== value) void onSave(option); }} className="task-cell-popover-item">
          <ScopePill scopeType={option} />
          <span className="flex-1" />
          {option === value && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
        </button>
      ))}
    </SopCellPopover>
  );
}

function InlineSopTargetCell({ scopeType, targetName, targetUser, scopeOptions, branchIds, departmentIds, userMembershipIds, pending, onSave }: { scopeType: ScopeType; targetName: string; targetUser?: SopTargetUser; scopeOptions?: SopScopeOptions; branchIds: string[]; departmentIds: string[]; userMembershipIds: string[]; pending?: boolean; onSave: (patch: { branchId?: Id<"branches">; departmentId?: Id<"departments">; userMembershipId?: Id<"companyMemberships"> }) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const selectedBranchId = branchIds[0];
  const selectedDepartmentId = departmentIds[0];
  const selectedUserMembershipId = userMembershipIds[0];
  const header = <span className="min-w-0 flex-1 truncate"><SopTargetValue scopeType={scopeType} targetName={targetName} user={targetUser} /></span>;

  let body: React.ReactNode;
  if (scopeType === "company") {
    body = <div className="px-2.5 py-2 text-[13px] text-[var(--ink-muted)]">Applies to the entire company.</div>;
  } else if (scopeType === "branch") {
    body = !scopeOptions ? <div className="px-2.5 py-2 text-[13px] text-[var(--ink-muted)]">Loading branches...</div> : scopeOptions.branches.length === 0 ? <div className="px-2.5 py-2 text-[13px] text-[var(--ink-muted)]">No branches available.</div> : scopeOptions.branches.map((branch) => (
      <button key={branch._id} type="button" onClick={() => { setOpen(false); if (branch._id !== selectedBranchId) void onSave({ branchId: branch._id }); }} className="task-cell-popover-item">
        <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        {branch._id === selectedBranchId && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
      </button>
    ));
  } else if (scopeType === "department") {
    body = !scopeOptions ? <div className="px-2.5 py-2 text-[13px] text-[var(--ink-muted)]">Loading departments...</div> : scopeOptions.departments.length === 0 ? <div className="px-2.5 py-2 text-[13px] text-[var(--ink-muted)]">No departments available.</div> : scopeOptions.departments.map((department) => (
      <button key={department._id} type="button" onClick={() => { setOpen(false); if (department._id !== selectedDepartmentId) void onSave({ departmentId: department._id }); }} className="task-cell-popover-item">
        <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--ink)]">{department.name}</span>{department.branchName && <span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{department.branchName}</span>}</span>
        {department._id === selectedDepartmentId && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
      </button>
    ));
  } else {
    body = !scopeOptions ? <div className="px-2.5 py-2 text-[13px] text-[var(--ink-muted)]">Loading users...</div> : scopeOptions.users.length === 0 ? <div className="px-2.5 py-2 text-[13px] text-[var(--ink-muted)]">No users available.</div> : scopeOptions.users.map((user) => {
      const id = user.membership._id;
      return (
        <button key={id} type="button" onClick={() => { setOpen(false); if (id !== selectedUserMembershipId) void onSave({ userMembershipId: id }); }} className="task-cell-popover-item">
          <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--ink)]">{user.user.name}</span><span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{user.membership.role}</span></span>
          {id === selectedUserMembershipId && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
        </button>
      );
    });
  }

  return <SopCellPopover open={open} onOpenChange={setOpen} disabled={pending} pending={pending} ariaLabel="Change SOP assignment" header={header} panelClassName="task-cell-popover-scroll">{body}</SopCellPopover>;
}

export function SopList({ selectedId }: { selectedId?: string }) {
  const router = useRouter();
  const { activeCompanyId, active } = useCompany();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sopView, setSopView] = useState<SopView>("all");
  const [scopeFilter, setScopeFilter] = useState<SopScopeFilter>("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [personFilter, setPersonFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pendingCell, setPendingCell] = useState<string | null>(null);
  const [optimisticRows, setOptimisticRows] = useState<Record<string, Record<string, unknown>>>({});
  const debouncedSearch = useDebouncedValue(search);
  const canUseAllSops = active?.membership.role === "Admin" || active?.membership.role === "Manager";
  const effectiveSopView: SopView = canUseAllSops ? sopView : "my";
  const canLoadScopeOptions = canLoadSopScopeOptions(active);
  const sops = useQuery(api.sops.listRows, activeCompanyId ? {
    companyId: activeCompanyId,
    search: debouncedSearch || undefined,
    view: effectiveSopView,
    scope: scopeFilter,
    branchId: branchFilter === "all" ? undefined : branchFilter as Id<"branches">,
    userMembershipId: personFilter === "all" || effectiveSopView === "my" ? undefined : personFilter as Id<"companyMemberships">,
  } : "skip") as any[] | undefined;
  const scopeOptions = useQuery(api.sops.scopeOptions, activeCompanyId && canLoadScopeOptions ? { companyId: activeCompanyId } : "skip") as SopScopeOptions | undefined;
  const filterOptions = useQuery(api.sops.filterOptions, activeCompanyId && canUseAllSops ? { companyId: activeCompanyId } : "skip") as SopScopeOptions | undefined;
  const update = useMutation(api.sops.update);
  const updateScope = useMutation(api.sops.updateScope);
  const remove = useMutation(api.sops.remove);
  const removeBulk = useMutation(api.sops.removeBulk);
  const isLoading = sops === undefined;
  const serverRows = useMemo(() => sops ?? [], [sops]);
  const rows = useMemo(() => serverRows.map((sop) => ({ ...sop, ...optimisticRows[sop._id] })), [optimisticRows, serverRows]);
  const canCreate = canCreateSops(active);
  const editableScopes = useMemo(() => editableScopeTypes.filter((scope) => canManageSop(active, scope)), [active]);
  const filterCount = [scopeFilter !== "all", branchFilter !== "all", effectiveSopView === "all" && personFilter !== "all"].filter(Boolean).length;
  const hasActiveFilters = filterCount > 0 || search.trim() !== "";
  const visibleIds = rows.map((sop) => sop._id as string);
  const selectedVisibleCount = visibleIds.reduce((count, id) => count + (selectedIds.has(id) ? 1 : 0), 0);
  const allVisibleSelected = rows.length > 0 && selectedVisibleCount === rows.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectionCount = selectedIds.size;
  const canDeleteSelection = selectionCount > 0 && !deleting;

  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  useEffect(() => {
    setOptimisticRows((current) => {
      let changed = false;
      const next = { ...current };
      for (const [id, patch] of Object.entries(current)) {
        const row = serverRows.find((candidate) => candidate._id === id);
        if (!row || patchMatches(row, patch)) { delete next[id]; changed = true; }
      }
      return changed ? next : current;
    });
  }, [serverRows]);

  useEffect(() => {
    if (!activeCompanyId) return;
    setSopView(canUseAllSops ? "all" : "my");
    setScopeFilter("all");
    setBranchFilter("all");
    setPersonFilter("all");
  }, [activeCompanyId, canUseAllSops]);

  useEffect(() => {
    if (effectiveSopView === "my" && personFilter !== "all") setPersonFilter("all");
  }, [effectiveSopView, personFilter]);

  useEffect(() => {
    if (rows.length && selectedIds.size > 0) {
      const known = new Set(rows.map((sop) => sop._id as string));
      const valid = new Set<string>();
      for (const id of selectedIds) if (known.has(id)) valid.add(id);
      if (valid.size !== selectedIds.size) setSelectedIds(valid);
    } else if (!rows.length && selectedIds.size > 0) {
      setSelectedIds(new Set());
    }
  }, [rows, selectedIds]);

  useEffect(() => {
    if (!createOpen || selectionCount === 0) return;
    setSelectedIds(new Set());
    setDeleteError(null);
  }, [createOpen, selectionCount]);

  function toggleOne(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDeleteError(null);
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      if (allVisibleSelected) {
        const next = new Set(current);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      const next = new Set(current);
      for (const id of visibleIds) next.add(id);
      return next;
    });
    setDeleteError(null);
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setDeleteError(null);
  }

  async function handleDeleteSelection() {
    if (!activeCompanyId || deleting || selectionCount === 0) return;
    setDeleting(true);
    setDeleteError(null);
    const ids = Array.from(selectedIds);
    try {
      if (ids.length === 1) await remove({ companyId: activeCompanyId, sopId: ids[0] as Id<"sops"> });
      else await removeBulk({ companyId: activeCompanyId, sopIds: ids as Id<"sops">[] });
      setSelectedIds(new Set());
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete the selected SOPs.");
    } finally {
      setDeleting(false);
    }
  }

  async function saveTitle(sop: any, title: string) {
    if (!activeCompanyId) return false;
    const key = `${sop._id}:title`;
    setOptimisticRows((current) => ({ ...current, [sop._id]: { ...current[sop._id], title } }));
    setPendingCell(key);
    setInlineError(null);
    try {
      await update({ companyId: activeCompanyId, sopId: sop._id as Id<"sops">, title, content: sop.content });
      return true;
    } catch (err) {
      setOptimisticRows((current) => { const next = { ...current }; delete next[sop._id]; return next; });
      setInlineError(err instanceof Error ? err.message : "Could not update the SOP.");
      return false;
    } finally {
      setPendingCell((current) => (current === key ? null : current));
    }
  }

  async function saveScope(sop: any, patch: { scopeType?: EditableScopeType; branchId?: Id<"branches">; departmentId?: Id<"departments">; userMembershipId?: Id<"companyMemberships"> }, label: string) {
    if (!activeCompanyId) return false;
    const nextScopeType = patch.scopeType ?? (sop.scopeType as EditableScopeType);
    let branchIds: Id<"branches">[] = [];
    let departmentIds: Id<"departments">[] = [];
    let userMembershipIds: Id<"companyMemberships">[] = [];
    if (nextScopeType === "branch") {
      const branchId = patch.branchId ?? (sop.scopeType === "branch" ? sop.branchIds?.[0] : undefined) ?? scopeOptions?.branches[0]?._id;
      if (!branchId) { setInlineError(scopeOptions ? "No branches are available." : "Scope options are still loading."); return false; }
      branchIds = [branchId as Id<"branches">];
    } else if (nextScopeType === "department") {
      const departmentId = patch.departmentId ?? (sop.scopeType === "department" ? sop.departmentIds?.[0] : undefined) ?? scopeOptions?.departments[0]?._id;
      if (!departmentId) { setInlineError(scopeOptions ? "No departments are available." : "Scope options are still loading."); return false; }
      departmentIds = [departmentId as Id<"departments">];
    } else if (nextScopeType === "user") {
      const userMembershipId = patch.userMembershipId ?? (sop.scopeType === "user" ? sop.userMembershipIds?.[0] : undefined) ?? scopeOptions?.users[0]?.membership._id;
      if (!userMembershipId) { setInlineError(scopeOptions ? "No users are available." : "Scope options are still loading."); return false; }
      userMembershipIds = [userMembershipId as Id<"companyMemberships">];
    }
    if (nextScopeType === sop.scopeType && (nextScopeType !== "branch" || branchIds[0] === sop.branchIds?.[0]) && (nextScopeType !== "department" || departmentIds[0] === sop.departmentIds?.[0]) && (nextScopeType !== "user" || userMembershipIds[0] === sop.userMembershipIds?.[0])) return true;
    const scopeTargetUser = nextScopeType === "user" ? scopeOptions?.users.find((user) => user.membership._id === userMembershipIds[0])?.user ?? sop.scopeTargetUser : null;
    const scopeTargetName = nextScopeType === "company" ? active?.company.name ?? "Company" : nextScopeType === "branch" ? scopeOptions?.branches.find((branch) => branch._id === branchIds[0])?.name ?? sop.scopeTargetName : nextScopeType === "department" ? scopeOptions?.departments.find((department) => department._id === departmentIds[0])?.name ?? sop.scopeTargetName : scopeTargetUser?.name ?? sop.scopeTargetName;
    const optimisticPatch = { scopeType: nextScopeType, branchIds, departmentIds, userMembershipIds, scopeTargetName, scopeTargetUser };
    const key = `${sop._id}:${label}`;
    setOptimisticRows((current) => ({ ...current, [sop._id]: { ...current[sop._id], ...optimisticPatch } }));
    setPendingCell(key);
    setInlineError(null);
    try {
      await updateScope({ companyId: activeCompanyId, sopId: sop._id as Id<"sops">, scopeType: nextScopeType, branchIds, departmentIds, userMembershipIds });
      return true;
    } catch (err) {
      setOptimisticRows((current) => { const next = { ...current }; delete next[sop._id]; return next; });
      setInlineError(err instanceof Error ? err.message : "Could not update the SOP scope.");
      return false;
    } finally {
      setPendingCell((current) => (current === key ? null : current));
    }
  }

  return (
    <div>
      <PageHeader title="SOPs" description="Searchable operating procedures with company, branch, department, and user visibility." />

      <SopDialog mode="create" open={createOpen} onOpenChange={setCreateOpen} onCreated={(id) => router.push(`/sops/${id}`)} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="task-view-toggle" aria-label="SOP view">
          {canUseAllSops && (
            <button type="button" className="task-view-button" data-active={effectiveSopView === "all"} onClick={() => setSopView("all")}>
              <StarIcon className="h-4 w-4" />All SOPs
            </button>
          )}
          <button type="button" className="task-view-button" data-active={effectiveSopView === "my"} disabled={!canUseAllSops} onClick={() => setSopView("my")}>
            <User className="h-4 w-4" />My SOPs
          </button>
        </div>
        <div className="ml-auto flex flex-1 items-center justify-end gap-2">
          <div className="task-search-control" data-open={searchOpen || search.trim() !== ""}>
            <Input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} className="task-search-input border-none focus:border-none bg-transparent" placeholder="Search SOPs" aria-label="Search SOPs by title or body" tabIndex={searchOpen || search.trim() !== "" ? 0 : -1} />
            <button type="button" className="task-search-button" aria-label={search ? "Clear search" : "Search SOPs"} onClick={() => { if (search) setSearch(""); else setSearchOpen((open) => !open); }}>
              {search ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
          </div>
          {canUseAllSops && (
            <SopFilterMenu
              scopeFilter={scopeFilter}
              branchFilter={branchFilter}
              personFilter={personFilter}
              branches={filterOptions?.branches ?? []}
              users={filterOptions?.users ?? []}
              activeCount={filterCount}
              showPersonFilter={effectiveSopView === "all"}
              onScopeChange={setScopeFilter}
              onBranchChange={setBranchFilter}
              onPersonChange={setPersonFilter}
            />
          )}
          {canCreate && <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />New SOP</Button>}
        </div>
      </div>

      {inlineError && (
        <div className="alert-error mb-3 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]" role="alert">
          <span>{inlineError}</span>
          <button type="button" className="task-icon-btn h-6 w-6" onClick={() => setInlineError(null)} aria-label="Dismiss error"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="relative">
        {selectionCount > 0 && (
          <div className="task-selection-layer">
            <div className="task-selection-pill" role="status" aria-live="polite">
              <span className="task-selection-pill-count">{selectionCount} selected</span>
              <span className="task-selection-pill-divider" aria-hidden="true" />
              <button type="button" className="task-selection-pill-btn" onClick={clearSelection} disabled={deleting} aria-label="Cancel selection">
                <X className="h-4 w-4" />
              </button>
              <span className="task-selection-pill-divider" aria-hidden="true" />
              <button type="button" className="task-selection-pill-btn" data-danger="true" onClick={handleDeleteSelection} disabled={!canDeleteSelection} aria-label={selectionCount === 1 ? "Delete selected SOP" : `Delete ${selectionCount} selected SOPs`}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {deleteError && <p className="alert-error task-selection-error" role="alert">{deleteError}</p>}
          </div>
        )}

        <div className="task-table-wrap relative -ml-11 w-[calc(100%+2.75rem)] overflow-x-auto pl-11">
        {rows.length > 0 && (
          <div className="task-checkbox-rail pointer-events-none absolute left-0 top-0 z-10 flex w-11 flex-col pr-2">
            <div className="flex h-9 items-center justify-end group/head pointer-events-auto">
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected}
                onCheckedChange={toggleAllVisible}
                disabled={rows.length === 0}
                aria-label={allVisibleSelected ? "Unselect all SOPs" : "Select all SOPs"}
                className={cn("transition-opacity", selectionCount > 0 ? "opacity-100" : "opacity-0 group-hover/head:opacity-100")}
              />
            </div>
            {rows.map((sop) => {
              const isChecked = selectedIds.has(sop._id);
              return (
                <div key={`rail-${sop._id}`} className="group/rail flex h-[41px] items-center justify-end pointer-events-auto">
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => toggleOne(sop._id)}
                    aria-label={isChecked ? `Unselect ${sop.title}` : `Select ${sop.title}`}
                    className={cn("transition-opacity", isChecked ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 group-hover/rail:opacity-100 focus-visible:opacity-100")}
                  />
                </div>
              );
            })}
          </div>
        )}
        <table className="task-table">
          <thead>
            <tr className="group/head">
              <th className="min-w-[200px] max-w-[420px]"><span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />Title</span></th>
              <th><span className="inline-flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" />Scope</span></th>
              <th><span className="inline-flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />Assigned to</span></th>
              <th><span className="inline-flex items-center gap-1.5"><History className="h-3.5 w-3.5" />Updated</span></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, index) => (
                <tr key={`skel-${index}`}>
                  <td colSpan={4} className="pl-4">
                    <div className="flex items-center gap-3">
                      <div className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-[var(--surface-muted)]" />
                      <div className="h-3 w-2/5 animate-pulse rounded bg-[var(--surface-muted)]" />
                    </div>
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="!h-auto py-2">
                  <div className="task-empty">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><Inbox className="h-5 w-5" /></span>
                    <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">{hasActiveFilters ? "No matching SOPs" : "No SOPs yet"}</div>
                    <p className="mt-1 max-w-[300px] text-[13px] text-[var(--ink-muted)]">{hasActiveFilters ? "Try adjusting your search or filters." : canCreate ? "Create your first procedure to get started." : "No procedures have been added yet."}</p>
                    {canCreate && !hasActiveFilters && (
                      <Button className="mt-4" size="sm" variant="primary" onClick={() => setCreateOpen(true)}><Plus className="h-3.5 w-3.5" />New SOP</Button>
                    )}
                    {hasActiveFilters && (
                      <Button className="mt-4" size="sm" variant="ghost" onClick={() => { setSearch(""); setSearchOpen(false); setScopeFilter("all"); setBranchFilter("all"); setPersonFilter("all"); }}>Clear filters</Button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              <>
                {rows.map((sop) => {
                  const isChecked = selectedIds.has(sop._id);
                  const sopScope = sop.scopeType as ScopeType;
                  const editableScope = editableScopeTypes.includes(sopScope as EditableScopeType) ? sopScope as EditableScopeType : null;
                  const rowCanEdit = canManageSop(active, sopScope);
                  const targetName = sopTargetName(sop, active?.company.name);
                  const pending = (field: string) => pendingCell === `${sop._id}:${field}`;
                  const detailsHref = `/sops/${sop._id}`;
                  const prefetchDetails = () => router.prefetch(detailsHref);
                  const openDetails = () => router.push(detailsHref);
                  return (
                    <tr
                      key={sop._id}
                      data-row="sop"
                      data-clickable={!rowCanEdit ? "true" : undefined}
                      data-selected={sop._id === selectedId}
                      data-checked={isChecked ? "true" : undefined}
                      tabIndex={!rowCanEdit ? 0 : undefined}
                      onMouseEnter={prefetchDetails}
                      onFocus={prefetchDetails}
                      onClick={(event) => {
                        if (rowCanEdit) return;
                        if ((event.target as HTMLElement).closest("[data-interactive='true']")) return;
                        openDetails();
                      }}
                      onKeyDown={(event) => {
                        if (!rowCanEdit && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openDetails(); }
                      }}
                      className="group/row"
                    >
                      <td className="col-task max-w-[420px]">
                        <div className="task-title-cell">
                          {rowCanEdit ? (
                            <InlineTitleCell value={sop.title ?? ""} ariaLabel="SOP title" pending={pending("title")} onSave={(title) => saveTitle(sop, title)} />
                          ) : (
                            <div className="flex min-w-0 items-center gap-2.5"><span className="min-w-0 flex-1 truncate">{sop.title}</span></div>
                          )}
                          {rowCanEdit && (
                            <button
                              type="button"
                              data-interactive="true"
                              data-tooltip="Open in side peek"
                              className="task-title-open"
                              onPointerDown={(event) => event.stopPropagation()}
                              onMouseEnter={prefetchDetails}
                              onFocus={prefetchDetails}
                              onClick={(event) => { event.stopPropagation(); openDetails(); }}
                              aria-label={`Open details for ${sop.title}`}
                            >
                              <PanelRight className="h-3.5 w-3.5" />
                              <span>OPEN</span>
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        {rowCanEdit && editableScope ? (
                          <InlineScopeCell value={editableScope} options={editableScopes} pending={pending("scope")} onSave={(scopeType) => saveScope(sop, { scopeType }, "scope")} />
                        ) : (
                          <ScopePill scopeType={sopScope} />
                        )}
                      </td>
                      <td className="max-w-[220px]">
                        {rowCanEdit && editableScope ? (
                          <InlineSopTargetCell scopeType={editableScope} targetName={targetName} targetUser={sop.scopeTargetUser} scopeOptions={scopeOptions} branchIds={sop.branchIds ?? []} departmentIds={sop.departmentIds ?? []} userMembershipIds={sop.userMembershipIds ?? []} pending={pending("assigned")} onSave={(patch) => saveScope(sop, patch, "assigned")} />
                        ) : (
                          <SopTargetValue scopeType={sopScope} targetName={targetName} user={sop.scopeTargetUser} />
                        )}
                      </td>
                      <td className="task-col-meta" title={`Updated ${formatDate(sop.updatedAt)} · Created ${formatDate(sop.createdAt)}`}>{relativeTime(sop.updatedAt)}</td>
                    </tr>
                  );
                })}
                {canCreate && (
                  <tr className="task-add-row">
                    <td colSpan={4}>
                      <button type="button" className="task-add-label inline-flex items-center gap-1.5" onClick={() => setCreateOpen(true)}>
                        <Plus className="h-3.5 w-3.5" />New SOP
                      </button>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
        </div>
      </div>

    </div>
  );
}

function PropertyRow({ icon, label, children, muted = false }: { icon: React.ReactNode; label: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex min-w-[74px] flex-col items-start gap-1">
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold leading-4 text-[var(--ink-muted)]">
        <span className="grid h-4 w-4 place-items-center text-[var(--ink-faint)] [&_svg]:shrink-0">{icon}</span>
        {label}
      </span>
      <div className={cn("sop-detail-prop-value flex min-h-[22px] min-w-0 items-center text-[13px] leading-5 text-[var(--ink)]", muted && "text-[var(--ink-faint)]")}>{children}</div>
    </div>
  );
}

function EditableSopField({ value, placeholder, variant, ariaLabel, canEdit, onSave }: { value: string; placeholder: string; variant: "title" | "body"; ariaLabel: string; canEdit: boolean; onSave: (value: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!focused && state !== "saving") setDraft(value); }, [focused, state, value]);
  useLayoutEffect(() => { if (variant === "title") autoSize(ref); }, [draft, canEdit, variant]);

  async function commit() {
    const next = draft.trim();
    if (next === value.trim()) return;
    if (variant === "body" ? !richTextPlainText(next) : !next) { setDraft(value); setState("error"); setError(variant === "title" ? "Title is required." : "Body is required."); return; }
    setState("saving");
    setError(null);
    const ok = await onSave(next);
    if (ok) {
      setState("saved");
      window.setTimeout(() => setState((current) => (current === "saved" ? "idle" : current)), 1200);
    } else {
      setState("error");
      setError("Could not save.");
      setDraft(value);
    }
  }

  if (!canEdit) {
    if (variant === "title") return <h1 className="text-[26px] font-bold leading-tight tracking-[-0.025em] text-[var(--ink)]">{value}</h1>;
    return <SopRichTextViewer value={value} placeholder={placeholder} />;
  }

  if (variant === "body") {
    return (
      <div className="task-detail-editable-wrap">
        <SopRichTextEditor
          value={draft}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); void commit(); }}
          onEscape={() => { setDraft(value); setError(null); setState("idle"); }}
          onChange={(next) => { setDraft(next); if (state === "error") setState("idle"); }}
        />
        {(state === "saving" || state === "saved" || error) && (
          <div className="task-detail-save-state" data-error={error ? "true" : undefined} aria-live="polite">{error ?? (state === "saving" ? "Saving..." : "Saved")}</div>
        )}
      </div>
    );
  }

  return (
    <div className="task-detail-editable-wrap">
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="task-detail-editable task-detail-editable-title"
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); void commit(); }}
        onChange={(event) => { setDraft(event.target.value); if (state === "error") setState("idle"); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setDraft(value); setError(null); setState("idle"); event.currentTarget.blur(); }
        }}
      />
      {(state === "saving" || state === "saved" || error) && (
        <div className="task-detail-save-state" data-error={error ? "true" : undefined} aria-live="polite">{error ?? (state === "saving" ? "Saving..." : "Saved")}</div>
      )}
    </div>
  );
}

function SopDetailSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="peek-bar"><div className="h-7 w-10 rounded bg-[var(--surface-muted)]" /></div>
      <div className="h-7 w-2/3 rounded bg-[var(--surface-muted)]" />
      <div className="mt-5 h-6 w-24 rounded bg-[var(--surface-muted)]" />
      <div className="mt-7 space-y-1.5">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="flex justify-between rounded-md py-2.5">
            <div className="h-3 w-24 rounded bg-[var(--surface-muted)]" />
            <div className="h-3 w-28 rounded bg-[var(--surface-muted)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SopDetailNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="task-empty">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><FileText className="h-5 w-5" /></span>
      <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">Procedure not found</div>
      <p className="mt-1 max-w-[300px] text-[13px] text-[var(--ink-muted)]">This procedure may have been removed, or you no longer have access to it.</p>
      <Button className="mt-4" size="sm" variant="ghost" onClick={onBack}>Back to procedures</Button>
    </div>
  );
}

export function SopDetail({ id }: { id: string }) {
  const router = useRouter();
  const { activeCompanyId, active } = useCompany();
  const serverSopResult = useQuery_experimental({ query: api.sops.get, args: activeCompanyId ? { companyId: activeCompanyId, sopId: id as Id<"sops"> } : "skip" });
  const serverSop = serverSopResult.status === "success" ? (serverSopResult.data as any) : undefined;
  const scopeOptions = useQuery(api.sops.scopeOptions, activeCompanyId && canLoadSopScopeOptions(active) ? { companyId: activeCompanyId } : "skip") as SopScopeOptions | undefined;
  const update = useMutation(api.sops.update);
  const updateScope = useMutation(api.sops.updateScope);
  const editableScopes = useMemo(() => editableScopeTypes.filter((scope) => canManageSop(active, scope)), [active]);
  const [editOpen, setEditOpen] = useState(false);
  const [pendingProperty, setPendingProperty] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [optimisticSop, setOptimisticSop] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (serverSop && optimisticSop && patchMatches(serverSop, optimisticSop)) setOptimisticSop(null);
  }, [optimisticSop, serverSop]);

  if (serverSopResult.status === "error") return <SopDetailNotFound onBack={() => router.push("/sops")} />;
  if (!serverSop) return <SopDetailSkeleton />;
  const sop = optimisticSop ? { ...serverSop, ...optimisticSop } : serverSop;
  const sopScope = sop.scopeType as ScopeType;
  const editableScope = editableScopeTypes.includes(sopScope as EditableScopeType) ? sopScope as EditableScopeType : null;
  const canEdit = canManageSop(active, sopScope);
  const targetName = sopTargetName(sop, active?.company.name);

  async function saveText(patch: { title?: string; body?: string }) {
    if (!activeCompanyId) return false;
    const optimisticPatch = { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.body !== undefined ? { content: patch.body } : {}) };
    setOptimisticSop((current) => ({ ...(current ?? {}), ...optimisticPatch }));
    setFieldError(null);
    try {
      await update({ companyId: activeCompanyId, sopId: id as Id<"sops">, title: patch.title ?? sop.title, content: patch.body ?? sop.content });
      return true;
    } catch (err) {
      setOptimisticSop(null);
      setFieldError(err instanceof Error ? err.message : "Could not update the SOP.");
      return false;
    }
  }

  async function saveScope(patch: { scopeType?: EditableScopeType; branchId?: Id<"branches">; departmentId?: Id<"departments">; userMembershipId?: Id<"companyMemberships"> }, label: string) {
    if (!activeCompanyId) return false;
    const nextScopeType = patch.scopeType ?? (sop.scopeType as EditableScopeType);
    let branchIds: Id<"branches">[] = [];
    let departmentIds: Id<"departments">[] = [];
    let userMembershipIds: Id<"companyMemberships">[] = [];
    if (nextScopeType === "branch") {
      const branchId = patch.branchId ?? (sop.scopeType === "branch" ? sop.branchIds?.[0] : undefined) ?? scopeOptions?.branches[0]?._id;
      if (!branchId) { setFieldError(scopeOptions ? "No branches are available." : "Scope options are still loading."); return false; }
      branchIds = [branchId as Id<"branches">];
    } else if (nextScopeType === "department") {
      const departmentId = patch.departmentId ?? (sop.scopeType === "department" ? sop.departmentIds?.[0] : undefined) ?? scopeOptions?.departments[0]?._id;
      if (!departmentId) { setFieldError(scopeOptions ? "No departments are available." : "Scope options are still loading."); return false; }
      departmentIds = [departmentId as Id<"departments">];
    } else if (nextScopeType === "user") {
      const userMembershipId = patch.userMembershipId ?? (sop.scopeType === "user" ? sop.userMembershipIds?.[0] : undefined) ?? scopeOptions?.users[0]?.membership._id;
      if (!userMembershipId) { setFieldError(scopeOptions ? "No users are available." : "Scope options are still loading."); return false; }
      userMembershipIds = [userMembershipId as Id<"companyMemberships">];
    }
    if (nextScopeType === sop.scopeType && (nextScopeType !== "branch" || branchIds[0] === sop.branchIds?.[0]) && (nextScopeType !== "department" || departmentIds[0] === sop.departmentIds?.[0]) && (nextScopeType !== "user" || userMembershipIds[0] === sop.userMembershipIds?.[0])) return true;
    const scopeTargetUser = nextScopeType === "user" ? scopeOptions?.users.find((user) => user.membership._id === userMembershipIds[0])?.user ?? sop.scopeTargetUser : null;
    const scopeTargetName = nextScopeType === "company" ? active?.company.name ?? "Company" : nextScopeType === "branch" ? scopeOptions?.branches.find((branch) => branch._id === branchIds[0])?.name ?? sop.scopeTargetName : nextScopeType === "department" ? scopeOptions?.departments.find((department) => department._id === departmentIds[0])?.name ?? sop.scopeTargetName : scopeTargetUser?.name ?? sop.scopeTargetName;
    const optimisticPatch = { scopeType: nextScopeType, branchIds, departmentIds, userMembershipIds, scopeTargetName, scopeTargetUser };
    setOptimisticSop((current) => ({ ...(current ?? {}), ...optimisticPatch }));
    setPendingProperty(label);
    setFieldError(null);
    try {
      await updateScope({ companyId: activeCompanyId, sopId: id as Id<"sops">, scopeType: nextScopeType, branchIds, departmentIds, userMembershipIds });
      return true;
    } catch (err) {
      setOptimisticSop(null);
      setFieldError(err instanceof Error ? err.message : "Could not update the SOP scope.");
      return false;
    } finally {
      setPendingProperty((current) => (current === label ? null : current));
    }
  }

  return (
    <div>
      <div className="peek-bar -mt-7 -mx-6 px-2 md:-mt-8 md:-mx-9 md:px-3">
        <div className="flex items-center gap-1">
          <button type="button" className="task-icon-btn" aria-label="Close details" onClick={() => { if (!requestDetailDrawerClose("/sops")) router.push("/sops"); }}>
            <ChevronsRight className="h-5 w-5" />
          </button>
        </div>
        {canEdit && (
          <div className="flex items-center gap-1">
            <button type="button" className="task-icon-btn" aria-label="Edit SOP" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <SopDialog mode="edit" open={editOpen} onOpenChange={setEditOpen} sop={sop} />

      {fieldError && <p className="alert-error mt-4 rounded-md p-2 text-[13px]" role="alert">{fieldError}</p>}

      <div className="pt-6">
        <EditableSopField value={sop.title ?? ""} placeholder="Untitled procedure" ariaLabel="Edit SOP title" canEdit={canEdit} variant="title" onSave={(title) => saveText({ title })} />
      </div>

      <div className="task-section !mt-6">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <PropertyRow icon={<Layers className="h-3.5 w-3.5" />} label="Scope">
            {canEdit && editableScope ? (
              <InlineScopeCell value={editableScope} options={editableScopes} pending={pendingProperty === "scope"} onSave={(scopeType) => saveScope({ scopeType }, "scope")} />
            ) : (
              <ScopePill scopeType={sopScope} />
            )}
          </PropertyRow>
          <PropertyRow icon={<Users className="h-3.5 w-3.5" />} label="Assigned To">
            {canEdit && editableScope ? (
              <InlineSopTargetCell scopeType={editableScope} targetName={targetName} targetUser={sop.scopeTargetUser} scopeOptions={scopeOptions} branchIds={sop.branchIds ?? []} departmentIds={sop.departmentIds ?? []} userMembershipIds={sop.userMembershipIds ?? []} pending={pendingProperty === "assigned"} onSave={(patch) => saveScope(patch, "assigned")} />
            ) : (
              <SopTargetValue scopeType={sopScope} targetName={targetName} user={sop.scopeTargetUser} />
            )}
          </PropertyRow>
          <PropertyRow icon={<History className="h-3.5 w-3.5" />} label="Updated" muted={!sop.updatedAt}>{relativeTime(sop.updatedAt)}</PropertyRow>
        </div>
      </div>

      <section className="task-section">
        <h2 className="task-section-title">Procedure</h2>
        <EditableSopField value={sop.content ?? ""} placeholder={canEdit ? "Write the procedure steps..." : "No content."} ariaLabel="Edit SOP body" canEdit={canEdit} variant="body" onSave={(body) => saveText({ body })} />
      </section>
    </div>
  );
}