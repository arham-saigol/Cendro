"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CalendarClock,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  Inbox,
  Maximize2,
  Minimize2,
  Paperclip,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  User,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "./company-context";
import { PageHeader } from "./page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDate, initials } from "@/lib/utils";

type Kind = "jd" | "one";
type Priority = "low" | "medium" | "high";
type Frequency = "daily" | "every_other_day" | "monthly" | "semiannually" | "annually";
type ManualStatus = "due" | "in_progress" | "completed";
type StatusFilter = "all" | ManualStatus | "overdue";
type TaskView = "all" | "my";
type PriorityFilter = "all" | Priority;

type TaskFormValues = {
  title: string;
  description: string;
  assigneeMembershipIds: string[];
  recurrence: Frequency;
  priority: Priority;
  dueDate: string;
  quantity: string;
  time: string;
  files: File[];
};

const frequencies: { value: Frequency; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "every_other_day", label: "Alternate days" },
  { value: "monthly", label: "Monthly" },
  { value: "semiannually", label: "Bi-yearly" },
  { value: "annually", label: "Yearly" },
];
const priorities: Priority[] = ["low", "medium", "high"];
const manualStatuses: { value: ManualStatus; label: string }[] = [
  { value: "due", label: "Not Started" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
];

const toneClasses: Record<string, string> = {
  blue: "bg-[var(--badge-blue-bg)] text-[var(--badge-blue-fg)]",
  green: "bg-[var(--badge-green-bg)] text-[var(--badge-green-fg)]",
  red: "bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]",
  yellow: "bg-[var(--badge-yellow-bg)] text-[var(--badge-yellow-fg)]",
  neutral: "bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-fg)]",
};

function emptyForm(kind: Kind): TaskFormValues {
  return { title: "", description: "", assigneeMembershipIds: [], recurrence: "daily", priority: "medium", dueDate: kind === "one" ? toDateField(Date.now() + 86_400_000) : "", quantity: "", time: "", files: [] };
}

function formFromTask(kind: Kind, task: any): TaskFormValues {
  return {
    title: task.title ?? "",
    description: task.description ?? "",
    assigneeMembershipIds: task.assigneeMembershipIds ?? [],
    recurrence: task.recurrence ?? "daily",
    priority: task.priority ?? "medium",
    dueDate: kind === "one" && task.dueDate ? toDateField(task.dueDate) : "",
    quantity: task.quantity ? String(task.quantity) : "",
    time: task.time ?? "",
    files: [],
  };
}

function toDateField(ms: number) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}
function dateFromField(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const date = slashMatch ? new Date(Number(slashMatch[3]), Number(slashMatch[2]) - 1, Number(slashMatch[1])) : new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}
function fromDateInput(value: string) {
  const date = dateFromField(value);
  if (!date) return undefined;
  date.setHours(23, 59, 59, 0);
  return date.getTime();
}
function quantityFromInput(value: string) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; }
function frequencyLabel(value?: Frequency) { return frequencies.find((frequency) => frequency.value === value)?.label ?? "—"; }
function priorityLabel(value?: Priority) { return value ? value[0].toUpperCase() + value.slice(1) : "—"; }
function statusText(task: any) { return typeof task.state === "string" ? task.state : task.state?.status ?? "Not Started"; }
function rawStatus(task: any): ManualStatus | "overdue" { return task.state?.rawStatus ?? (statusText(task) === "Completed" ? "completed" : statusText(task) === "In Progress" ? "in_progress" : statusText(task) === "Overdue" ? "overdue" : statusText(task) === "Not Started" ? "due" : "due"); }
function statusTone(status: string) { if (status === "Overdue") return "red"; if (status === "Completed") return "green"; if (status === "In Progress") return "blue"; return "neutral"; }
function statusDotClass(status: ManualStatus | "overdue") { return status === "completed" ? "bg-[var(--badge-green-fg)]" : status === "in_progress" ? "bg-[var(--badge-blue-fg)]" : status === "overdue" ? "bg-[var(--badge-red-fg)]" : "bg-[var(--badge-neutral-fg)]"; }
function taskTypeFor(kind: Kind) { return kind === "jd" ? "jd" : "one_time"; }
function hasAnyCapability(active: { capabilities: string[] } | null | undefined, capabilities: string[]) { return capabilities.some((capability) => active?.capabilities.includes(capability)); }
function canCreateTasks(active: { capabilities: string[] } | null | undefined, kind: Kind) { return active?.capabilities.includes(kind === "jd" ? "tasks:jd:create" : "tasks:one_time:create") ?? false; }
function canEditTasks(active: { capabilities: string[] } | null | undefined, kind: Kind) {
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  return hasAnyCapability(active, [`${prefix}:update:any`, `${prefix}:update:managed`, `${prefix}:update:self`]);
}
function statusMatches(task: any, filter: StatusFilter) {
  if (filter === "all") return true;
  const raw = rawStatus(task);
  if (filter === "overdue") return raw === "overdue" || statusText(task) === "Overdue";
  return raw === filter;
}
function taskHasAssignee(task: any, membershipId?: string) { return Boolean(membershipId && Array.isArray(task.assigneeMembershipIds) && task.assigneeMembershipIds.includes(membershipId)); }
function assigneeDisplayName(assignee: any) { return assignee?.user?.name || assignee?.user?.email || "Unknown user"; }
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
function humanSize(bytes?: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${i <= 1 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
function priorityChipClasses(priority: Priority) {
  return priority === "high" ? "bg-[var(--priority-high-bg)] text-[var(--priority-high-fg)]" : priority === "medium" ? "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]" : "bg-[var(--priority-low-bg)] text-[var(--priority-low-fg)]";
}
function dueLabel(task: any) {
  const ms = task.dueDate;
  if (!ms) return "—";
  const day = 86_400_000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const dueDay = new Date(ms); dueDay.setHours(0, 0, 0, 0);
  const delta = Math.round((dueDay.getTime() - startOfToday.getTime()) / day);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  if (delta > 1 && delta <= 6) return `In ${delta}d`;
  if (delta < 0 && delta >= -6) return `${Math.abs(delta)}d ago`;
  return formatDate(ms);
}
function dueTone(task: any) {
  const ms = task.dueDate;
  if (!ms) return "muted";
  if (rawStatus(task) === "completed") return "muted";
  if (rawStatus(task) === "overdue" || ms < Date.now()) return "danger";
  const day = 86_400_000;
  if (ms - Date.now() <= 2 * day) return "warn";
  return "ink";
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92ZM40,108a44,44,0,1,1,44,44A44.05,44.05,0,0,1,40,108Zm210.14,98.7a8,8,0,0,1-11.07-2.33A79.83,79.83,0,0,0,172,168a8,8,0,0,1,0-16,44,44,0,1,0-16.34-84.87,8,8,0,1,1-5.94-14.85,60,60,0,0,1,55.53,105.64,95.83,95.83,0,0,1,47.22,37.71A8,8,0,0,1,250.14,206.7Z" />
    </svg>
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M234.29,114.85l-45,38.83L203,211.75a16.4,16.4,0,0,1-24.5,17.82L128,198.49,77.47,229.57A16.4,16.4,0,0,1,53,211.75l13.76-58.07-45-38.83A16.46,16.46,0,0,1,31.08,86l59-4.76,22.76-55.08a16.36,16.36,0,0,1,30.27,0l22.75,55.08,59,4.76a16.46,16.46,0,0,1,9.37,28.86Z" />
    </svg>
  );
}

function StatusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M225.86,102.82c-3.77-3.94-7.67-8-9.14-11.57-1.36-3.27-1.44-8.69-1.52-13.94-.15-9.76-.31-20.82-8-28.51s-18.75-7.85-28.51-8c-5.25-.08-10.67-.16-13.94-1.52-3.56-1.47-7.63-5.37-11.57-9.14C146.28,23.51,138.44,16,128,16s-18.27,7.51-25.18,14.14c-3.94,3.77-8,7.67-11.57,9.14C88,40.64,82.56,40.72,77.31,40.8c-9.76.15-20.82.31-28.51,8S41,67.55,40.8,77.31c-.08,5.25-.16,10.67-1.52,13.94-1.47,3.56-5.37,7.63-9.14,11.57C23.51,109.72,16,117.56,16,128s7.51,18.27,14.14,25.18c3.77,3.94,7.67,8,9.14,11.57,1.36,3.27,1.44,8.69,1.52,13.94.15,9.76.31,20.82,8,28.51s18.75,7.85,28.51,8c5.25.08,10.67.16,13.94,1.52,3.56,1.47,7.63,5.37,11.57,9.14C109.72,232.49,117.56,240,128,240s18.27-7.51,25.18-14.14c3.94-3.77,8-7.67,11.57-9.14,3.27-1.36,8.69-1.44,13.94-1.52,9.76-.15,20.82-.31,28.51-8s7.85-18.75,8-28.51c.08-5.25.16-10.67,1.52-13.94,1.47-3.56,5.37-7.63,9.14-11.57C232.49,146.28,240,138.44,240,128S232.49,109.73,225.86,102.82Zm-11.55,39.29c-4.79,5-9.75,10.17-12.38,16.52-2.52,6.1-2.63,13.07-2.73,19.82-.1,7-.21,14.33-3.32,17.43s-10.39,3.22-17.43,3.32c-6.75.1-13.72.21-19.82,2.73-6.35,2.63-11.52,7.59-16.52,12.38S132,224,128,224s-9.15-4.92-14.11-9.69-10.17-9.75-16.52-12.38c-6.1-2.52-13.07-2.63-19.82-2.73-7-.1-14.33-.21-17.43-3.32s-3.22-10.39-3.32-17.43c-.1-6.75-.21-13.72-2.73-19.82-2.63-6.35-7.59-11.52-12.38-16.52S32,132,32,128s4.92-9.15,9.69-14.11,9.75-10.17,12.38-16.52c2.52-6.1,2.63-13.07,2.73-19.82.1-7,.21-14.33,3.32-17.43S70.51,56.9,77.55,56.8c6.75-.1,13.72-.21,19.82-2.73,6.35-2.63,11.52-7.59,16.52-12.38S124,32,128,32s9.15,4.92,14.11,9.69,10.17,9.75,16.52,12.38c6.1,2.52,13.07,2.63,19.82,2.73,7,.1,14.33.21,17.43,3.32s3.22,10.39,3.32,17.43c.1,6.75.21,13.72,2.73,19.82,2.63,6.35,7.59,11.52,12.38,16.52S224,124,224,128,219.08,137.15,214.31,142.11ZM173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34Z" />
    </svg>
  );
}

function TaskIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M238.73,43.67A8,8,0,0,0,232,40H152a8,8,0,0,0-7.28,4.69L135.94,64H28a8,8,0,0,0-5.92,13.38L57.19,116,22.08,154.62A8,8,0,0,0,28,168h73.09a8,8,0,0,0,7.28-4.69L117.15,144h62.43l-34.86,76.69a8,8,0,1,0,14.56,6.62l80-176A8,8,0,0,0,238.73,43.67ZM95.94,152H46.08l27.84-30.62a8,8,0,0,0,0-10.76L46.08,80h82.59Zm90.91-24H124.42l32.73-72h62.43Z" />
    </svg>
  );
}

function FrequencyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h28.69L182.06,73.37a79.56,79.56,0,0,0-56.13-23.43h-.45A79.52,79.52,0,0,0,69.59,72.71,8,8,0,0,1,58.41,61.27a96,96,0,0,1,135,.79L208,76.69V48a8,8,0,0,1,16,0ZM186.41,183.29a80,80,0,0,1-112.47-.66L59.31,168H88a8,8,0,0,0,0-16H40a8,8,0,0,0-8,8v48a8,8,0,0,0,16,0V179.31l14.63,14.63A95.43,95.43,0,0,0,130,222.06h.53a95.36,95.36,0,0,0,67.07-27.33,8,8,0,0,0-11.18-11.44Z" />
    </svg>
  );
}

function QuantityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M230.91,172A8,8,0,0,1,228,182.91l-96,56a8,8,0,0,1-8.06,0l-96-56A8,8,0,0,1,36,169.09l92,53.65,92-53.65A8,8,0,0,1,230.91,172ZM220,121.09l-92,53.65L36,121.09A8,8,0,0,0,28,134.91l96,56a8,8,0,0,0,8.06,0l96-56A8,8,0,1,0,220,121.09ZM24,80a8,8,0,0,1,4-6.91l96-56a8,8,0,0,1,8.06,0l96,56a8,8,0,0,1,0,13.82l-96,56a8,8,0,0,1-8.06,0l-96-56A8,8,0,0,1,24,80Zm23.88,0L128,126.74,208.12,80,128,33.26Z" />
    </svg>
  );
}

function Avatar({ name, email, size = "sm" }: { name?: string | null; email?: string | null; size?: "sm" | "md" | "lg" }) {
  const dim = size === "md" ? "h-7 w-7 text-[11px]" : size === "lg" ? "h-9 w-9 text-xs" : "h-6 w-6 text-[10px]";
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--surface-hover),var(--surface-pressed))] font-semibold text-[var(--ink-secondary)] ring-2 ring-[var(--canvas)]", dim)} title={name || email || undefined}>
      {initials(name, email)}
    </span>
  );
}

function AvatarStack({ assignees, max = 3, showName = false }: { assignees: { user: { name: string | null; email: string } }[]; max?: number; showName?: boolean }) {
  if (!assignees.length) return <span className="text-[12.5px] text-[var(--ink-faint)]">Unassigned</span>;
  const shown = assignees.slice(0, max);
  const extra = assignees.length - shown.length;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="avatar-stack shrink-0">
        {shown.map((assignee, index) => <Avatar key={index} name={assignee.user.name} email={assignee.user.email} />)}
        {extra > 0 && <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hover)] text-[10px] font-semibold text-[var(--ink-secondary)] ring-2 ring-[var(--canvas)]">+{extra}</span>}
      </span>
      {showName && <span className="min-w-0 truncate">{assigneeDisplayName(assignees[0])}</span>}
    </span>
  );
}

function StatusBadge({ kind, task, size = "sm" }: { kind: Kind; task: any; size?: "sm" | "md" }) {
  const { activeCompanyId, active } = useCompany();
  const updateJdStatus = useMutation(api.tasks.updateJdStatus);
  const updateOneStatus = useMutation(api.tasks.updateOneTimeStatus);
  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<ManualStatus | null>(null);
  const status = statusText(task);
  const raw = optimistic ?? rawStatus(task);
  const locked = status === "Overdue" || raw === "overdue";
  const canUpdate = canEditTasks(active, kind);
  const pad = size === "md" ? "h-7 px-2.5" : "h-[22px] px-2";

  async function change(nextStatus: ManualStatus) {
    if (!activeCompanyId || locked || pending) return;
    setPending(true);
    setOptimistic(nextStatus);
    try {
      if (kind === "jd") await updateJdStatus({ companyId: activeCompanyId, taskId: task._id, status: nextStatus });
      else await updateOneStatus({ companyId: activeCompanyId, taskId: task._id, status: nextStatus });
      setOptimistic(null);
    } catch {
      setOptimistic(null);
    } finally {
      setPending(false);
    }
  }

  if (locked) return <span className={cn("task-pill", toneClasses[statusTone("Overdue")], pad)} aria-label="Overdue (locked)"><span className="task-pill-dot bg-[var(--badge-red-fg)]" />Overdue</span>;
  if (!canUpdate) return <span className={cn("task-pill", toneClasses[statusTone(status)], pad)}><span className={cn("task-pill-dot", statusDotClass(raw))} />{status}</span>;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" disabled={pending} onClick={(event) => event.stopPropagation()} data-interactive="true" className={cn("task-pill", toneClasses[statusTone(status)], pad)} aria-label="Change status">
          <span className={cn("task-pill-dot", statusDotClass(raw))} />
          {manualStatuses.find((option) => option.value === raw)?.label ?? status}
          <ChevronDown className="task-pill-chevron h-3 w-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="task-menu" onClick={(event) => event.stopPropagation()}>
          {manualStatuses.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => change(option.value)} className="task-menu-item">
              <span className={cn("task-pill-dot", statusDotClass(option.value))} />
              <span className="flex-1">{option.label}</span>
              {raw === option.value && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function TaskFilterSubmenu<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; avatar?: React.ReactNode }[]; onChange: (value: T) => void }) {
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

function TaskFilterMenu({
  kind,
  statusFilter,
  frequency,
  priorityFilter,
  assigneeFilter,
  assignees,
  showAssigneeFilter,
  activeCount,
  onStatusChange,
  onFrequencyChange,
  onPriorityChange,
  onAssigneeChange,
}: {
  kind: Kind;
  statusFilter: StatusFilter;
  frequency: Frequency | "all";
  priorityFilter: PriorityFilter;
  assigneeFilter: string;
  assignees: any[];
  showAssigneeFilter: boolean;
  activeCount: number;
  onStatusChange: (value: StatusFilter) => void;
  onFrequencyChange: (value: Frequency | "all") => void;
  onPriorityChange: (value: PriorityFilter) => void;
  onAssigneeChange: (value: string) => void;
}) {
  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: "all", label: "All statuses" },
    { value: "due", label: "Not Started" },
    { value: "in_progress", label: "In progress" },
    { value: "completed", label: "Completed" },
    { value: "overdue", label: "Overdue" },
  ];
  const priorityOptions: { value: PriorityFilter; label: string }[] = [{ value: "all", label: "All priorities" }, ...priorities.map((priority) => ({ value: priority, label: priorityLabel(priority) }))];
  const frequencyOptions: { value: Frequency | "all"; label: string }[] = [{ value: "all", label: "All frequencies" }, ...frequencies];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-toolbar-icon" data-active={activeCount > 0} aria-label="Filter tasks">
          <SlidersHorizontal className="h-4 w-4" />
          {activeCount > 0 && <span className="task-toolbar-badge">{activeCount}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="task-menu min-w-48" aria-label="Task filters">
          <TaskFilterSubmenu label="Status" value={statusFilter} options={statusOptions} onChange={onStatusChange} />
          {kind === "jd" ? (
            <TaskFilterSubmenu label="Frequency" value={frequency} options={frequencyOptions} onChange={onFrequencyChange} />
          ) : (
            <TaskFilterSubmenu label="Priority" value={priorityFilter} options={priorityOptions} onChange={onPriorityChange} />
          )}
          {showAssigneeFilter && (
            <TaskFilterSubmenu
              label="Assignee"
              value={assigneeFilter}
              options={[{ value: "all", label: "All assignees" }, ...assignees.map((assignee) => ({ value: assignee.membership._id as string, label: assigneeDisplayName(assignee), avatar: <Avatar name={assignee.user.name} email={assignee.user.email} /> }))]}
              onChange={onAssigneeChange}
            />
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SelectPicker<T extends string>({ ariaLabel, value, options, onChange, placeholder = "Select" }: { ariaLabel: string; value: T; options: { value: T; label: string; helper?: string }[]; onChange: (value: T) => void; placeholder?: string }) {
  const selectedOption = options.find((option) => option.value === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-inline-control">
          <span className={cn("truncate", !selectedOption && "text-[var(--ink-faint)]")}>{selectedOption?.label ?? placeholder}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="task-menu w-[var(--radix-dropdown-menu-trigger-width)]" aria-label={ariaLabel}>
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

function AssigneePicker({ assignable, selected, onChange, required = false }: { assignable: any[]; selected: string[]; onChange: (ids: string[]) => void; required?: boolean }) {
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const selectedAssignee = assignable.find((assignee) => assignee.membership._id === selected[0]);
  const filtered = assignable.filter((assignee) => `${assignee.user.name || ""} ${assignee.user.email || ""} ${assignee.membership.role}`.toLowerCase().includes(searchValue.toLowerCase()));
  if (!assignable.length) return <div className="py-2 text-[13px] text-[var(--ink-faint)]">No assignable people.</div>;
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((current) => !current)} className="task-inline-control">
        {selectedAssignee ? <Avatar name={selectedAssignee.user.name} email={selectedAssignee.user.email} /> : <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><User className="h-3.5 w-3.5" /></span>}
        <span className={cn("min-w-0 flex-1 truncate", !selectedAssignee && "text-[var(--ink-faint)]")}>{selectedAssignee ? (selectedAssignee.user.name || selectedAssignee.user.email) : required ? "Select assignee" : "Unassigned"}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-[70]" onClick={() => { setOpen(false); setSearchValue(""); }} />
          <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[71] rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-popover)]">
            <div className="relative px-1 pb-1.5 pt-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-faint)]" />
              <Input aria-label="Search assignees" className="h-8 rounded-md pl-8 text-[13px]" value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="Search people" autoFocus />
            </div>
            <div className="max-h-56 overflow-auto p-0.5">
              {!required && (
                <button type="button" onClick={() => { onChange([]); setOpen(false); setSearchValue(""); }} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--surface-muted)]">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><User className="h-3.5 w-3.5" /></span>
                  <span className="flex-1 text-[var(--ink-secondary)]">Unassigned</span>
                  {!selected[0] && <Check className="h-4 w-4 text-[var(--primary)]" />}
                </button>
              )}
              {filtered.map((assignee) => {
                const id = assignee.membership._id as string;
                const name = assignee.user.name || assignee.user.email;
                return (
                  <button key={id} type="button" onClick={() => { onChange([id]); setOpen(false); setSearchValue(""); }} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--surface-muted)]">
                    <Avatar name={assignee.user.name} email={assignee.user.email} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--ink)]">{name}</span><span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{assignee.membership.role}</span></span>
                    {selected[0] === id && <Check className="h-4 w-4 shrink-0 text-[var(--primary)]" />}
                  </button>
                );
              })}
              {filtered.length === 0 && <div className="px-2.5 py-3 text-[13px] text-[var(--ink-muted)]">No people found.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const selectedDate = dateFromField(value);
  const [open, setOpen] = useState(false);
  const [today] = useState(() => toDateField(Date.now()));
  const [monthDate, setMonthDate] = useState(() => selectedDate ?? new Date());
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const blanks = (monthStart.getDay() + 6) % 7;
  const monthLabel = monthDate.toLocaleString(undefined, { month: "long", year: "numeric" });

  function pick(day: number) {
    onChange(toDateField(new Date(monthDate.getFullYear(), monthDate.getMonth(), day).getTime()));
    setOpen(false);
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-inline-control">
          <CalendarDays className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
          <span className={cn("min-w-0 flex-1 truncate", !value && "text-[var(--ink-faint)]")}>{value || "Add date"}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="task-menu w-72 p-3">
          <div className="mb-3 flex items-center justify-between">
            <button type="button" className="task-icon-btn" onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></button>
            <div className="text-[13px] font-semibold text-[var(--ink)]">{monthLabel}</div>
            <button type="button" className="task-icon-btn" onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-[var(--ink-faint)]">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <div key={`${day}-${index}`} className="py-1">{day}</div>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {Array.from({ length: blanks }).map((_, index) => <div key={`blank-${index}`} />)}
            {Array.from({ length: daysInMonth }).map((_, index) => {
              const day = index + 1;
              const dateValue = toDateField(new Date(monthDate.getFullYear(), monthDate.getMonth(), day).getTime());
              const selected = value === dateValue;
              return (
                <button key={day} type="button" onClick={() => pick(day)} className={cn("h-8 rounded-md text-[13px] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-muted)]", dateValue === today && "font-semibold text-[var(--primary)]", selected && "bg-[var(--primary)] !text-[var(--on-primary)] hover:!bg-[var(--primary-hover)]")}>
                  {day}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-[var(--hairline)] pt-3">
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange("")}>Clear</Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => { onChange(today); setMonthDate(new Date()); setOpen(false); }}>Today</Button>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AttachmentPicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  function addFiles(nextFiles: File[]) {
    const merged = [...files];
    for (const file of nextFiles) {
      if (!merged.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) merged.push(file);
    }
    onChange(merged);
  }

  return (
    <div className="grid gap-1.5">
      <label className="task-inline-control cursor-pointer">
        <Paperclip className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
        <span className="truncate text-[var(--ink-faint)]">Add attachments</span>
        <input className="sr-only" type="file" multiple onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
      </label>
      {files.length > 0 && (
        <div className="grid gap-1.5">
          {files.map((file, index) => (
            <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex h-9 items-center gap-2 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px]">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]">{file.name}</span>
              <button type="button" onClick={() => onChange(files.filter((_, fileIndex) => fileIndex !== index))} className="task-icon-btn h-6 w-6 rounded" aria-label={`Remove ${file.name}`}><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskDialog({ kind, mode, open, onOpenChange, task, assignable }: { kind: Kind; mode: "create" | "edit"; open: boolean; onOpenChange: (open: boolean) => void; task?: any; assignable: any[] }) {
  const { activeCompanyId, active } = useCompany();
  const createJd = useMutation(api.tasks.createJd);
  const createOne = useMutation(api.tasks.createOneTime);
  const updateJd = useMutation(api.tasks.updateJd);
  const updateOne = useMutation(api.tasks.updateOneTime);
  const generateUploadUrl = useMutation(api.tasks.generateAttachmentUploadUrl);
  const addAttachment = useMutation(api.tasks.addAttachment);
  const [values, setValues] = useState<TaskFormValues>(() => task ? formFromTask(kind, task) : emptyForm(kind));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [persistedTaskId, setPersistedTaskId] = useState<string | null>(null);

  function reset(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setError(null);
      setSaving(false);
      setPersistedTaskId(null);
      setValues(task ? formFromTask(kind, task) : emptyForm(kind));
    }
  }
  function patch(update: Partial<TaskFormValues>) { setValues((current) => ({ ...current, ...update })); setError(null); }

  async function uploadFiles(taskId: string, files: File[]) {
    if (!activeCompanyId || files.length === 0 || !active?.capabilities.includes("tasks:attachment:add")) return;
    for (const file of [...files]) {
      const postUrl = await generateUploadUrl({ companyId: activeCompanyId });
      const response = await fetch(postUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
      const json = await response.json() as { storageId?: Id<"_storage"> };
      if (!json.storageId) throw new Error(`Could not upload ${file.name}.`);
      await addAttachment({ companyId: activeCompanyId, taskType: taskTypeFor(kind), taskId, storageId: json.storageId, fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size });
      setValues((current) => ({ ...current, files: current.files.filter((candidate) => candidate !== file) }));
    }
  }

  async function submit() {
    if (!activeCompanyId || saving) return;
    if (!values.title.trim()) { setError("Task title is required."); return; }
    if (mode === "create" && values.assigneeMembershipIds.length === 0) { setError("Assignee is required."); return; }
    if (kind === "jd" && !values.recurrence) { setError("Frequency is required."); return; }
    setSaving(true);
    setError(null);
    try {
      let taskId = persistedTaskId ?? (task?._id as string | undefined);
      const common = { companyId: activeCompanyId, title: values.title.trim(), description: values.description, time: values.time, quantity: quantityFromInput(values.quantity), assigneeMembershipIds: values.assigneeMembershipIds as Id<"companyMemberships">[] };
      if (!persistedTaskId) {
        if (kind === "jd") {
          if (mode === "create") taskId = await createJd({ ...common, recurrence: values.recurrence });
          else await updateJd({ ...common, taskId: task._id, recurrence: values.recurrence });
        } else {
          const payload = { ...common, dueDate: fromDateInput(values.dueDate), priority: values.priority };
          if (mode === "create") taskId = await createOne(payload);
          else await updateOne({ ...payload, taskId: task._id });
        }
        if (mode === "create" && taskId) setPersistedTaskId(taskId);
      }
      if (taskId) await uploadFiles(taskId, values.files);
      reset(false);
      setValues(emptyForm(kind));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save task.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={reset}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(760px,92dvh)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--hairline)] px-6 py-4">
            <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{mode === "create" ? `New ${kind === "jd" ? "JD " : ""}task` : `Edit ${kind === "jd" ? "JD " : ""}task`}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="task-icon-btn" aria-label="Close"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Create or edit a {kind === "jd" ? "JD" : "one-time"} task.</Dialog.Description>

          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <input aria-label="Task title" className="w-full border-none bg-transparent text-lg font-semibold tracking-[-0.01em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" value={values.title} onChange={(event) => patch({ title: event.target.value })} placeholder="Untitled" autoFocus />

              <div className="mt-4 divide-y divide-[var(--hairline)] border-y border-[var(--hairline)]">
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                  <span className="text-[13px] text-[var(--ink-muted)]">Assignee</span>
                  <div className="min-w-0"><AssigneePicker assignable={assignable} selected={values.assigneeMembershipIds} onChange={(ids) => patch({ assigneeMembershipIds: ids })} required={mode === "create"} /></div>
                </div>
                {kind === "jd" ? (
                  <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                    <span className="text-[13px] text-[var(--ink-muted)]">Frequency</span>
                    <div className="min-w-0"><SelectPicker ariaLabel="Frequency" value={values.recurrence} options={frequencies} onChange={(recurrence) => patch({ recurrence })} /></div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                      <span className="text-[13px] text-[var(--ink-muted)]">Priority</span>
                      <div className="min-w-0"><SelectPicker ariaLabel="Priority" value={values.priority} options={priorities.map((priority) => ({ value: priority, label: priorityLabel(priority) }))} onChange={(priority) => patch({ priority })} /></div>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                      <span className="text-[13px] text-[var(--ink-muted)]">Due date</span>
                      <div className="min-w-0"><DatePicker value={values.dueDate} onChange={(dueDate) => patch({ dueDate })} /></div>
                    </div>
                  </>
                )}
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                  <span className="text-[13px] text-[var(--ink-muted)]">Quantity</span>
                  <div className="min-w-0"><input aria-label="Quantity" className="h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" inputMode="decimal" value={values.quantity} onChange={(event) => patch({ quantity: event.target.value })} placeholder="None" /></div>
                </div>
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                  <span className="text-[13px] text-[var(--ink-muted)]">Time</span>
                  <div className="min-w-0"><input aria-label="Time estimate" className="h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" value={values.time} onChange={(event) => patch({ time: event.target.value })} placeholder="None" /></div>
                </div>
                <div className="grid grid-cols-[120px_1fr] items-start gap-3 py-2">
                  <span className="pt-2 text-[13px] text-[var(--ink-muted)]">Description</span>
                  <div className="min-w-0"><textarea aria-label="Description" className="block w-full resize-none border-none bg-transparent px-2 py-2 text-[13px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" rows={3} value={values.description} onChange={(event) => patch({ description: event.target.value })} placeholder="Add context, notes, or acceptance criteria." /></div>
                </div>
                {active?.capabilities.includes("tasks:attachment:add") && (
                  <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                    <span className="text-[13px] text-[var(--ink-muted)]">Attachments</span>
                    <div className="min-w-0"><AttachmentPicker files={values.files} onChange={(files) => patch({ files })} /></div>
                  </div>
                )}
              </div>

              {error && <p className="alert-error mt-4 rounded-md px-3 py-2 text-[13px]" role="alert">{error}</p>}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--hairline)] px-6 py-4">
              <Button type="button" variant="secondary" onClick={() => reset(false)}>Cancel</Button>
              <Button type="submit" size="lg" variant="primary" disabled={saving || !values.title.trim() || (mode === "create" && values.assigneeMembershipIds.length === 0)}>{saving ? "Saving..." : persistedTaskId ? "Retry upload" : mode === "create" ? "Create task" : "Save changes"}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TaskList({ kind, selectedId }: { kind: Kind; selectedId?: string }) {
  const router = useRouter();
  const { activeCompanyId, active } = useCompany();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [taskView, setTaskView] = useState<TaskView>("all");
  const [frequency, setFrequency] = useState<Frequency | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const canUseAllTasks = active?.membership.role === "Admin" || active?.membership.role === "Manager";
  const assignable = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: taskTypeFor(kind) } : "skip") as any[] | undefined;
  const filterableAssignees = useQuery(api.tasks.filterableAssignees, activeCompanyId && canUseAllTasks ? { companyId: activeCompanyId } : "skip") as any[] | undefined;
  const tasks = useQuery(kind === "jd" ? api.tasks.listJdRows : api.tasks.listOneTimeRows, activeCompanyId ? (kind === "jd" ? { companyId: activeCompanyId, search: search || undefined, frequency, sort: "newest" as const } : { companyId: activeCompanyId, search: search || undefined, sort: "newest" as const }) : "skip") as any[] | undefined;
  const deleteJd = useMutation(api.tasks.deleteJd);
  const deleteJdBulk = useMutation(api.tasks.deleteJdBulk);
  const deleteOneTime = useMutation(api.tasks.deleteOneTime);
  const deleteOneTimeBulk = useMutation(api.tasks.deleteOneTimeBulk);
  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";
  const pageTitle = kind === "jd" ? "JD Tasks" : "One-Time Tasks";
  const description = kind === "jd" ? "Recurring role responsibilities with cycle-aware status and clear ownership." : "One-off work with priority, due dates, and clear completion status.";
  const canCreate = canCreateTasks(active, kind);
  const effectiveTaskView: TaskView = canUseAllTasks ? taskView : "my";
  const currentMembershipId = active?.membership._id as string | undefined;
  const visibleTasks = (tasks ?? []).filter((task) => {
    if (effectiveTaskView === "my" && !taskHasAssignee(task, currentMembershipId)) return false;
    if (!statusMatches(task, statusFilter)) return false;
    if (kind === "one" && priorityFilter !== "all" && task.priority !== priorityFilter) return false;
    if (assigneeFilter !== "all" && !taskHasAssignee(task, assigneeFilter)) return false;
    return true;
  });
  const visibleIds = visibleTasks.map((task) => task._id);
  const selectedVisibleCount = visibleIds.reduce((count, id) => count + (selectedIds.has(id) ? 1 : 0), 0);
  const allVisibleSelected = visibleTasks.length > 0 && selectedVisibleCount === visibleTasks.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectionCount = selectedIds.size;
  const canDeleteSelection = selectionCount > 0 && !deleting;

  useEffect(() => {
    if (!activeCompanyId) return;
    setTaskView(canUseAllTasks ? "all" : "my");
    setAssigneeFilter("all");
  }, [activeCompanyId, canUseAllTasks]);

  useEffect(() => {
    if (effectiveTaskView === "my" && assigneeFilter !== "all") setAssigneeFilter("all");
  }, [effectiveTaskView, assigneeFilter]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (tasks && selectedIds.size > 0) {
      const valid = new Set<string>();
      const known = new Set((tasks ?? []).map((task) => task._id));
      for (const id of selectedIds) if (known.has(id)) valid.add(id);
      if (valid.size !== selectedIds.size) setSelectedIds(valid);
    }
  }, [tasks, selectedIds]);

  useEffect(() => {
    if (!createOpen) return;
    if (selectionCount === 0) return;
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
      if (kind === "jd") {
        if (ids.length === 1) await deleteJd({ companyId: activeCompanyId, taskId: ids[0] as Id<"jdTasks"> });
        else await deleteJdBulk({ companyId: activeCompanyId, taskIds: ids as Id<"jdTasks">[] });
      } else {
        if (ids.length === 1) await deleteOneTime({ companyId: activeCompanyId, taskId: ids[0] as Id<"oneTimeTasks"> });
        else await deleteOneTimeBulk({ companyId: activeCompanyId, taskIds: ids as Id<"oneTimeTasks">[] });
      }
      setSelectedIds(new Set());
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete the selected tasks.");
    } finally {
      setDeleting(false);
    }
  }

  const jdColumns = 6; // task + frequency + assignee + status + time + quantity
  const oneColumns = 7; // task + priority + assignee + status + due + time + quantity
  const filterCount = [statusFilter !== "all", kind === "jd" ? frequency !== "all" : priorityFilter !== "all", assigneeFilter !== "all"].filter(Boolean).length;
  const hasActiveFilters = filterCount > 0 || search.trim() !== "";

  return (
    <div>
      <PageHeader
        title={pageTitle}
        description={description}
      />

      <TaskDialog kind={kind} mode="create" open={createOpen} onOpenChange={setCreateOpen} assignable={assignable ?? []} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="task-view-toggle" aria-label="Task view">
          {canUseAllTasks && (
            <button type="button" className="task-view-button" data-active={effectiveTaskView === "all"} onClick={() => setTaskView("all")}>
              <StarIcon className="h-4 w-4" />All Tasks
            </button>
          )}
          <button type="button" className="task-view-button" data-active={effectiveTaskView === "my"} disabled={!canUseAllTasks} onClick={() => setTaskView("my")}>
            <User className="h-4 w-4" />My Tasks
          </button>
        </div>
        <div className="ml-auto flex flex-1 items-center justify-end gap-2">
          <div className="task-search-control" data-open={searchOpen || search.trim() !== ""}>
            <Input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} className="task-search-input border-none focus:border-none bg-transparent" placeholder="Search title" aria-label="Search tasks by title" tabIndex={searchOpen || search.trim() !== "" ? 0 : -1} />
            <button type="button" className="task-search-button" aria-label={search ? "Clear search" : "Search tasks"} onClick={() => { if (search) setSearch(""); else setSearchOpen((open) => !open); }}>
              {search ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
          </div>
          <TaskFilterMenu
            kind={kind}
            statusFilter={statusFilter}
            frequency={frequency}
            priorityFilter={priorityFilter}
            assigneeFilter={assigneeFilter}
            assignees={filterableAssignees ?? []}
            showAssigneeFilter={canUseAllTasks && effectiveTaskView === "all"}
            activeCount={filterCount}
            onStatusChange={setStatusFilter}
            onFrequencyChange={setFrequency}
            onPriorityChange={setPriorityFilter}
            onAssigneeChange={setAssigneeFilter}
          />
          {canCreate && <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />New task</Button>}
        </div>
      </div>

      {selectionCount > 0 && (
        <div className="task-bulk-bar mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--surface-pressed)] px-3 py-2 text-[13px]">
          <span className="font-medium text-[var(--ink)]">{selectionCount} selected</span>
          <span className="text-[var(--ink-faint)]">·</span>
          <span className="text-[var(--ink-muted)]">{selectedVisibleCount > 0 && selectedVisibleCount < selectionCount ? `${selectedVisibleCount} on this page` : "All on this page"}</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection} disabled={deleting}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleDeleteSelection} disabled={!canDeleteSelection}>
              <Trash2 className="h-3.5 w-3.5" />
              {selectionCount === 1 ? "Delete" : `Delete ${selectionCount}`}
            </Button>
          </div>
          {deleteError && <p className="alert-error basis-full rounded-md px-2 py-1.5 text-[12.5px]" role="alert">{deleteError}</p>}
        </div>
      )}

      <div className="task-table-wrap relative -ml-11 w-[calc(100%+2.75rem)] overflow-x-auto pl-11">
        {visibleTasks.length > 0 && (
          <div className="task-checkbox-rail pointer-events-none absolute left-0 top-0 z-10 flex w-11 flex-col pr-2">
            <div className="flex h-9 items-center justify-end group/head pointer-events-auto">
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected}
                onCheckedChange={toggleAllVisible}
                disabled={visibleTasks.length === 0}
                aria-label={allVisibleSelected ? "Unselect all tasks" : "Select all tasks"}
                className={cn("transition-opacity", selectionCount > 0 ? "opacity-100" : "opacity-0 group-hover/head:opacity-100")}
              />
            </div>
            {visibleTasks.map((task) => {
              const isChecked = selectedIds.has(task._id);
              return (
                <div key={`rail-${task._id}`} className="group/rail flex h-[41px] items-center justify-end pointer-events-auto">
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => toggleOne(task._id)}
                    aria-label={isChecked ? `Unselect ${task.title}` : `Select ${task.title}`}
                    className={cn("transition-opacity", isChecked ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 group-hover/rail:opacity-100 focus-visible:opacity-100")}
                  />
                </div>
              );
            })}
          </div>
        )}
        <table className="task-table">
          <thead>
            {kind === "jd" ? (
              <tr className="group/head">
                <th className="min-w-[200px] max-w-[250px]"><span className="inline-flex items-center gap-1.5"><TaskIcon className="h-3.5 w-3.5" />Task</span></th>
                <th><span className="inline-flex items-center gap-1.5"><FrequencyIcon className="h-3.5 w-3.5" />Frequency</span></th>
                <th><span className="inline-flex items-center gap-1.5"><UsersIcon className="h-3.5 w-3.5" />Assignee</span></th>
                <th><span className="inline-flex items-center gap-1.5"><StatusIcon className="h-3.5 w-3.5" />Status</span></th>
                <th><span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />Time</span></th>
                <th><span className="inline-flex items-center gap-1.5"><QuantityIcon className="h-3.5 w-3.5" />Quantity</span></th>
              </tr>
            ) : (
              <tr className="group/head">
                <th className="min-w-[200px] max-w-[250px]"><span className="inline-flex items-center gap-1.5"><TaskIcon className="h-3.5 w-3.5" />Task</span></th>
                <th><span className="inline-flex items-center gap-1.5"><Tag className="h-3.5 w-3.5" />Priority</span></th>
                <th><span className="inline-flex items-center gap-1.5"><UsersIcon className="h-3.5 w-3.5" />Assignee</span></th>
                <th><span className="inline-flex items-center gap-1.5"><StatusIcon className="h-3.5 w-3.5" />Status</span></th>
                <th><span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />Due</span></th>
                <th><span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />Time</span></th>
                <th><span className="inline-flex items-center gap-1.5"><QuantityIcon className="h-3.5 w-3.5" />Quantity</span></th>
              </tr>
            )}
          </thead>
          <tbody>
            {!tasks ? (
              Array.from({ length: 6 }).map((_, index) => (
                <tr key={`skel-${index}`}>
                  <td colSpan={kind === "jd" ? jdColumns : oneColumns} className="pl-4">
                    <div className="flex items-center gap-3">
                      <div className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-[var(--surface-muted)]" />
                      <div className="h-3 w-2/5 animate-pulse rounded bg-[var(--surface-muted)]" />
                    </div>
                  </td>
                </tr>
              ))
            ) : visibleTasks.length === 0 ? (
              <tr>
                <td colSpan={kind === "jd" ? jdColumns : oneColumns} className="!h-auto py-2">
                  <div className="task-empty">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><Inbox className="h-5 w-5" /></span>
                    <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">{tasks.length === 0 ? "No tasks yet" : "No matching tasks"}</div>
                    <p className="mt-1 max-w-[280px] text-[13px] text-[var(--ink-muted)]">{tasks.length === 0 ? "Create your first task to get started." : "Try adjusting your search or filters."}</p>
                    {canCreate && tasks.length === 0 && (
                      <Button className="mt-4" size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
                        <Plus className="h-3.5 w-3.5" />New task
                      </Button>
                    )}
                    {hasActiveFilters && tasks.length > 0 && (
                      <Button className="mt-4" size="sm" variant="ghost" onClick={() => { setSearch(""); setSearchOpen(false); setStatusFilter("all"); setFrequency("all"); setPriorityFilter("all"); setAssigneeFilter("all"); }}>Clear filters</Button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              <>
                {visibleTasks.map((task) => {
                  const isChecked = selectedIds.has(task._id);
                  return (
                  <tr
                    key={task._id}
                    data-selected={task._id === selectedId}
                    data-checked={isChecked ? "true" : undefined}
                    onClick={() => router.push(`${base}/${task._id}`)}
                    className="group/row"
                  >
                    <td className="col-task max-w-[250px]">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="min-w-0 flex-1 truncate">{task.title}</span>
                      </div>
                    </td>
                    {kind === "jd" ? (
                      <td className="whitespace-nowrap text-[var(--ink-secondary)]">
                        {frequencyLabel(task.recurrence)}
                      </td>
                    ) : (
                      <td>
                        <span className={cn("priority-chip", priorityChipClasses(task.priority))}>
                          {priorityLabel(task.priority)}
                        </span>
                      </td>
                    )}
                    <td><AvatarStack assignees={task.assignees} showName /></td>
                    <td><StatusBadge kind={kind} task={task} /></td>
                    {kind === "one" && (
                      <td className="col-meta">
                        <span className={cn(dueTone(task) === "danger" && "font-medium text-[var(--danger)]", dueTone(task) === "warn" && "font-medium text-[var(--badge-yellow-fg)]", dueTone(task) === "muted" && "text-[var(--ink-faint)]")}>{dueLabel(task)}</span>
                      </td>
                    )}
                    <td>{task.time || "—"}</td>
                    <td>{task.quantity != null ? task.quantity : "—"}</td>
                  </tr>
                  );
                })}
                {canCreate && (
                  <tr className="task-add-row" onClick={() => setCreateOpen(true)}>
                    <td colSpan={kind === "jd" ? jdColumns : oneColumns} className="pl-4">
                      <span className="inline-flex items-center gap-1.5">
                        <Plus className="h-3.5 w-3.5" />New task
                      </span>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TaskDetailSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="peek-bar"><div className="h-7 w-28 rounded bg-[var(--surface-muted)]" /></div>
      <div className="h-7 w-2/3 rounded bg-[var(--surface-muted)]" />
      <div className="mt-2 h-3 w-44 rounded bg-[var(--surface-muted)]" />
      <div className="mt-5 h-6 w-24 rounded bg-[var(--surface-muted)]" />
      <div className="mt-7 space-y-1.5">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="flex justify-between rounded-md py-2.5">
            <div className="h-3 w-24 rounded bg-[var(--surface-muted)]" />
            <div className="h-3 w-32 rounded bg-[var(--surface-muted)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function PropertyRow({ icon, label, children, muted = false }: { icon: React.ReactNode; label: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className="prop-row">
      <span className="prop-label">
        <span className="grid h-4 w-4 place-items-center">{icon}</span>
        {label}
      </span>
      <div className={cn("prop-value", muted && "prop-value--muted")}>{children}</div>
    </div>
  );
}

function AttachmentList({ attachments, canDelete, onDelete }: { attachments: any[]; canDelete: boolean; onDelete: (id: Id<"taskAttachments">) => void }) {
  if (attachments.length === 0) return <div className="text-[13px] text-[var(--ink-faint)]">No attachments.</div>;
  return (
    <div className="grid gap-2">
      {attachments.map((attachment) => (
        <div key={attachment._id} className="group flex items-center gap-3 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 py-2 transition-colors hover:border-[var(--hairline-strong)]">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-muted)] text-[var(--ink-muted)]"><Paperclip className="h-4 w-4" /></span>
          <a className="min-w-0 flex-1" href={attachment.url ?? "#"} target="_blank" rel="noreferrer">
            <span className="block truncate text-[13px] font-medium text-[var(--primary)] hover:underline">{attachment.fileName}</span>
            <span className="block truncate text-[11.5px] text-[var(--ink-faint)]">{humanSize(attachment.size)}{attachment.createdAt ? ` · ${formatDate(attachment.createdAt)}` : ""}</span>
          </a>
          {canDelete && <button type="button" className="task-icon-btn h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => onDelete(attachment._id)} aria-label={`Delete ${attachment.fileName}`}><Trash2 className="h-3.5 w-3.5" /></button>}
        </div>
      ))}
    </div>
  );
}

function PeekBar({ kind, id, isFullView, canEdit, onEdit }: { kind: Kind; id: string; isFullView: boolean; canEdit: boolean; onEdit: () => void }) {
  const router = useRouter();
  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";

  return (
    <div className="peek-bar">
      <div className="flex items-center gap-1">
        {isFullView && (
          <button type="button" className="task-icon-btn" aria-label="Back to peek" onClick={() => router.push(`${base}/${id}`)}>
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />Edit
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1">
        {isFullView ? (
          <button type="button" className="task-icon-btn" aria-label="Collapse to peek" onClick={() => router.push(`${base}/${id}`)}>
            <Minimize2 className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button type="button" className="task-icon-btn" aria-label="Open in full page" onClick={() => router.push(`${base}/${id}/full`)}>
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" className="task-icon-btn" aria-label={isFullView ? "Back to list" : "Close"} onClick={() => router.push(base)}>
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function TaskDetail({ kind, id }: { kind: Kind; id: string }) {
  const { activeCompanyId, active } = useCompany();
  const pathname = usePathname();
  const taskType = taskTypeFor(kind);
  const isFullView = pathname.endsWith("/full");
  const data = useQuery(kind === "jd" ? api.tasks.getJd : api.tasks.getOneTime, activeCompanyId ? { companyId: activeCompanyId, taskId: id as any } : "skip") as any;
  const assignable = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: taskType } : "skip") as any[] | undefined;
  const commentsQuery = usePaginatedQuery(api.tasks.listComments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip", { initialNumItems: 25 });
  const attachmentsQuery = usePaginatedQuery(api.tasks.listAttachments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip", { initialNumItems: 25 });
  const attachments = attachmentsQuery.results as any[] | undefined;
  const comment = useMutation(api.tasks.addComment);
  const generateUploadUrl = useMutation(api.tasks.generateAttachmentUploadUrl);
  const addAttachment = useMutation(api.tasks.addAttachment);
  const deleteAttachment = useMutation(api.tasks.deleteAttachment);
  const [editOpen, setEditOpen] = useState(false);
  const [body, setBody] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [optimisticComments, setOptimisticComments] = useState<any[]>([]);

  const comments = useMemo(() => [...optimisticComments, ...((commentsQuery.results as any[]) ?? [])], [commentsQuery.results, optimisticComments]);
  const canManageAttachments = active?.capabilities.includes("tasks:attachment:add") ?? false;
  const canComment = active?.capabilities.includes("tasks:comment") ?? false;
  const canEdit = canEditTasks(active, kind);

  if (!data) return <TaskDetailSkeleton />;
  const task = data.task;

  async function upload(file: File) {
    if (!activeCompanyId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const postUrl = await generateUploadUrl({ companyId: activeCompanyId });
      const response = await fetch(postUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!response.ok) throw new Error("Upload failed.");
      const json = await response.json() as { storageId?: Id<"_storage"> };
      if (!json.storageId) throw new Error("Upload failed.");
      await addAttachment({ companyId: activeCompanyId, taskType, taskId: id, storageId: json.storageId, fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";
  const sectionLabel = kind === "jd" ? "JD Tasks" : "One-Time Tasks";
  const typeLabel = kind === "jd" ? "JD Task" : "One-Time Task";
  const primaryAssignee = task.assignees?.[0];

  return (
    <div>
      <PeekBar kind={kind} id={id} isFullView={isFullView} canEdit={canEdit} onEdit={() => setEditOpen(true)} />
      <TaskDialog kind={kind} mode="edit" open={editOpen} onOpenChange={setEditOpen} task={task} assignable={assignable ?? []} />

      {isFullView && (
        <nav className="mb-4 flex items-center gap-1.5 text-[12.5px] text-[var(--ink-muted)]">
          <Link href={base} className="rounded transition-colors hover:text-[var(--ink)]">{sectionLabel}</Link>
          <ChevronRight className="h-3 w-3 text-[var(--ink-faint)]" />
          <span className="truncate text-[var(--ink)]">{task.title}</span>
        </nav>
      )}

      <div className="pt-1">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] text-[var(--ink)]">{task.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[var(--ink-faint)]">
          <span>{typeLabel}</span>
          <span aria-hidden>·</span>
          <span>Updated {relativeTime(task.updatedAt)}</span>
        </div>
      </div>

      <div className="mt-5">
        <StatusBadge kind={kind} task={task} size="md" />
      </div>

      <div className="task-section !mt-6">
        <div className="prop-list">
          <PropertyRow icon={<UsersIcon className="h-3.5 w-3.5" />} label="Assignee" muted={!task.assignees?.length}>
            {task.assignees?.length ? (
              <span className="inline-flex items-center gap-2">
                {primaryAssignee && <Avatar name={primaryAssignee.user.name} email={primaryAssignee.user.email} />}
                <span className="truncate">{primaryAssignee?.user.name || primaryAssignee?.user.email}</span>
                {task.assignees.length > 1 && <span className="text-[var(--ink-faint)]">+{task.assignees.length - 1}</span>}
              </span>
            ) : "Unassigned"}
          </PropertyRow>
          {kind === "jd" ? (
            <PropertyRow icon={<FrequencyIcon className="h-3.5 w-3.5" />} label="Frequency">
              <span className="inline-flex items-center gap-1.5">{frequencyLabel(task.recurrence)}</span>
            </PropertyRow>
          ) : (
            <PropertyRow icon={<Flag className="h-3.5 w-3.5" />} label="Priority">
              <span className={cn("priority-chip", priorityChipClasses(task.priority))}>
                {priorityLabel(task.priority)}
              </span>
            </PropertyRow>
          )}
          {kind === "one" && <PropertyRow icon={<CalendarClock className="h-3.5 w-3.5" />} label="Due date" muted={!task.dueDate}>{dueLabel(task)}</PropertyRow>}
          <PropertyRow icon={<QuantityIcon className="h-3.5 w-3.5" />} label="Quantity" muted={task.quantity == null}>{task.quantity ?? "—"}</PropertyRow>
          <PropertyRow icon={<Clock className="h-3.5 w-3.5" />} label="Time" muted={!task.time}>{task.time || "—"}</PropertyRow>
          <PropertyRow icon={<CalendarDays className="h-3.5 w-3.5" />} label="Created">{formatDate(task.createdAt)}</PropertyRow>
        </div>
      </div>

      <section className="task-section">
        <h2 className="task-section-title">Description</h2>
        {task.description ? (
          <p className="whitespace-pre-wrap text-[14px] leading-7 text-[var(--ink-secondary)]">{task.description}</p>
        ) : (
          <p className="text-[14px] leading-7 text-[var(--ink-faint)]">No description.</p>
        )}
      </section>

      <section className="task-section">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="task-section-title !mb-0">Attachments</h2>
          {attachmentsQuery.status === "CanLoadMore" && <Button size="sm" variant="ghost" onClick={() => attachmentsQuery.loadMore(25)}>Load more</Button>}
        </div>
        <AttachmentList attachments={attachments ?? []} canDelete={canManageAttachments} onDelete={(attachmentId) => deleteAttachment({ companyId: activeCompanyId as Id<"companies">, attachmentId })} />
        {uploadError && <p className="alert-error mt-3 rounded-md p-2 text-[13px]">{uploadError}</p>}
        {canManageAttachments && (
          <label className="mt-3 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-muted)]">
            <input className="sr-only" type="file" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} />
            <Plus className="h-3.5 w-3.5" />{uploading ? "Uploading..." : "Attach file"}
          </label>
        )}
      </section>

      <section className="task-section">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="task-section-title !mb-0">Comments</h2>
          {commentsQuery.status === "CanLoadMore" && <Button size="sm" variant="ghost" onClick={() => commentsQuery.loadMore(25)}>Load more</Button>}
        </div>
        <div className="space-y-4">
          {comments.length === 0 && <div className="text-[13px] text-[var(--ink-faint)]">No comments yet.</div>}
          {comments.map((commentRow: any) => {
            const name = commentRow.author?.user.name || commentRow.author?.user.email || "You";
            return (
              <div key={commentRow._id} className="flex gap-3">
                <Avatar name={commentRow.author?.user.name ?? null} email={commentRow.author?.user.email ?? null} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold text-[var(--ink)]">{name}</span>
                    {commentRow.author?.membership?.role && <span className="text-[11.5px] text-[var(--ink-faint)]">{commentRow.author.membership.role}</span>}
                    {commentRow.createdAt && <span className="text-[11.5px] text-[var(--ink-faint)]">{relativeTime(commentRow.createdAt)}</span>}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-6 text-[var(--ink-secondary)]">{commentRow.body}</p>
                </div>
              </div>
            );
          })}
        </div>
        {canComment && (
          <div className="mt-4">
            <Textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Add a comment..." />
            <div className="mt-2 flex justify-end">
              <Button variant="primary" disabled={!body.trim()} onClick={async () => { const text = body.trim(); if (text) { const tempId = crypto.randomUUID(); setActionError(null); setOptimisticComments((current) => [{ _id: tempId, body: text }, ...current]); setBody(""); try { await comment({ companyId: activeCompanyId as Id<"companies">, taskType, taskId: id, body: text }); } catch (err) { setBody(text); setActionError(err instanceof Error ? err.message : "Could not add comment."); } finally { setOptimisticComments((current) => current.filter((commentRow) => commentRow._id !== tempId)); } } }}>Comment</Button>
            </div>
          </div>
        )}
        {actionError && <p className="alert-error mt-2 rounded-md p-2 text-[13px]">{actionError}</p>}
      </section>
    </div>
  );
}
