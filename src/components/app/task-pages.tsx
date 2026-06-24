"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowUp,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Clock,
  Flag,
  Inbox,
  PanelRight,
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
import { useRouter } from "next/navigation";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "./company-context";
import { PageHeader } from "./page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
    dueDate: kind === "one" && task.dueDate ? toDateField(task.dueDate, dateHasExplicitTime(task.dueDate)) : "",
    quantity: task.quantity ? String(task.quantity) : "",
    time: task.time ?? "",
    files: [],
  };
}

function dateHasExplicitTime(ms?: number | null) {
  if (!ms) return false;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return false;
  return !(date.getHours() === 23 && date.getMinutes() === 59 && date.getSeconds() === 59);
}
function formatDateOnly(date: Date, month: "short" | "long" = "long") {
  return new Intl.DateTimeFormat("en-US", { month, day: "numeric", year: "numeric" }).format(date);
}
function formatTimeOnly(date: Date) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}
function dateFieldHasTime(value: string) {
  return /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(value) || /\b\d{1,2}:\d{2}\b/.test(value);
}
function parseTimeParts(value: string) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (minutes < 0 || minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours < 0 || hours > 23) return null;
  return { hours, minutes };
}
function applyTimeText(date: Date, timeText?: string) {
  const parts = timeText ? parseTimeParts(timeText) : null;
  if (!parts) return false;
  date.setHours(parts.hours, parts.minutes, 0, 0);
  return true;
}
function toDateField(ms: number, includeTime = false) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return includeTime ? `${formatDateOnly(date)} ${formatTimeOnly(date)}` : formatDateOnly(date);
}
function dateFromField(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === "today" || lowered === "now") return new Date();
  if (lowered === "tomorrow") return new Date(Date.now() + 86_400_000);
  if (lowered === "yesterday") return new Date(Date.now() - 86_400_000);

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[\s,]+(.+))?$/.exec(trimmed);
  if (slashMatch) {
    const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]);
    const date = new Date(year, Number(slashMatch[2]) - 1, Number(slashMatch[1]));
    if (slashMatch[4]) applyTimeText(date, slashMatch[4]);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}
function fromDateInput(value: string) {
  const date = dateFromField(value);
  if (!date) return undefined;
  if (!dateFieldHasTime(value)) date.setHours(23, 59, 59, 0);
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
function canEditTaskRow(active: { capabilities: string[]; membership: { _id: string; role: string } } | null | undefined, kind: Kind, task: any) {
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (active?.capabilities.includes(`${prefix}:update:any`)) return true;
  if (active?.capabilities.includes(`${prefix}:update:managed`)) return true;
  return Boolean(active?.capabilities.includes(`${prefix}:update:self`) && taskHasAssignee(task, active.membership._id));
}
function canEditPriority(active: { membership: { role: string } } | null | undefined) { return active?.membership.role === "Admin" || active?.membership.role === "Manager"; }
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
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return dateHasExplicitTime(ms) ? `${formatDateOnly(date)} ${formatTimeOnly(date)}` : formatDateOnly(date);
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

function Avatar({ name, email, imageUrl, size = "sm" }: { name?: string | null; email?: string | null; imageUrl?: string | null; size?: "sm" | "md" | "lg" }) {
  const dim = size === "md" ? "h-7 w-7 text-[11px]" : size === "lg" ? "h-9 w-9 text-xs" : "h-6 w-6 text-[10px]";
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,var(--surface-hover),var(--surface-pressed))] font-semibold text-[var(--ink-secondary)] ring-2 ring-[var(--canvas)]", dim)} title={name || email || undefined}>
      {initials(name, email)}
      {imageUrl && <span aria-hidden="true" className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${imageUrl})` }} />}
    </span>
  );
}

function AvatarStack({ assignees, max = 3, showName = false }: { assignees: { user: { name: string | null; email: string; imageUrl?: string | null } }[]; max?: number; showName?: boolean }) {
  if (!assignees.length) return <span className="text-[12.5px] text-[var(--ink-faint)]">Unassigned</span>;
  const shown = assignees.slice(0, max);
  const extra = assignees.length - shown.length;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="avatar-stack shrink-0">
        {shown.map((assignee, index) => <Avatar key={index} name={assignee.user.name} email={assignee.user.email} imageUrl={assignee.user.imageUrl} />)}
        {extra > 0 && <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hover)] text-[10px] font-semibold text-[var(--ink-secondary)] ring-2 ring-[var(--canvas)]">+{extra}</span>}
      </span>
      {showName && <span className="min-w-0 truncate">{assigneeDisplayName(assignees[0])}</span>}
    </span>
  );
}

function TaskCellPopover({
  open,
  onOpenChange,
  disabled = false,
  pending = false,
  ariaLabel,
  header,
  children,
  panelClassName,
  showHeader = true,
  hideTriggerOnOpen = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
  ariaLabel: string;
  header: React.ReactNode;
  children: React.ReactNode;
  panelClassName?: string;
  showHeader?: boolean;
  hideTriggerOnOpen?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);

  function measure() {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setRect({ top: bounds.top, bottom: bounds.bottom, left: bounds.left - 14, width: Math.max(bounds.width + 28, 220) });
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
        data-cell-popover-open={open && hideTriggerOnOpen ? "true" : undefined}
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
          <div className={cn("task-cell-popover", panelClassName)} style={{ top: showHeader ? rect.top : rect.bottom + 4, left: rect.left, width: rect.width }} data-interactive="true" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            {showHeader && <div className="task-cell-popover-header">{header}</div>}
            <div className="task-cell-popover-body">{children}</div>
          </div>
        </>
      )}
    </span>
  );
}

function StatusBadge({ kind, task, size = "sm", canUpdateOverride, cellTrigger = false }: { kind: Kind; task: any; size?: "sm" | "md"; canUpdateOverride?: boolean; cellTrigger?: boolean }) {
  const { activeCompanyId, active } = useCompany();
  const updateJdStatus = useMutation(api.tasks.updateJdStatus);
  const updateOneStatus = useMutation(api.tasks.updateOneTimeStatus);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<ManualStatus | null>(null);
  const status = statusText(task);
  const raw = optimistic ?? rawStatus(task);
  const locked = status === "Overdue" || raw === "overdue";
  const canUpdate = canUpdateOverride ?? canEditTasks(active, kind);
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

  const pill = (
    <span className={cn("task-pill", toneClasses[statusTone(status)], pad)}>
      <span className={cn("task-pill-dot", statusDotClass(raw))} />
      {manualStatuses.find((option) => option.value === raw)?.label ?? status}
    </span>
  );

  if (cellTrigger) {
    return (
      <TaskCellPopover open={open} onOpenChange={setOpen} disabled={pending} pending={pending} ariaLabel="Change status" header={pill}>
        {manualStatuses.map((option) => (
          <button key={option.value} type="button" onClick={() => { setOpen(false); void change(option.value); }} className="task-cell-popover-item">
            <span className={cn("task-pill h-[22px] px-2", toneClasses[statusTone(option.label)])}>
              <span className={cn("task-pill-dot", statusDotClass(option.value))} />
              {option.label}
            </span>
            <span className="flex-1" />
            {raw === option.value && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
          </button>
        ))}
      </TaskCellPopover>
    );
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" disabled={pending} onClick={(event) => event.stopPropagation()} data-interactive="true" className={cn("task-pill", toneClasses[statusTone(status)], pad)} aria-label="Change status">
          <span className={cn("task-pill-dot", statusDotClass(raw))} />
          {manualStatuses.find((option) => option.value === raw)?.label ?? status}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="task-menu" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
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
              options={[{ value: "all", label: "All assignees" }, ...assignees.map((assignee) => ({ value: assignee.membership._id as string, label: assigneeDisplayName(assignee), avatar: <Avatar name={assignee.user.name} email={assignee.user.email} imageUrl={assignee.user.imageUrl} /> }))]}
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
        <button type="button" className="task-inline-control" data-interactive="true" onClick={(event) => event.stopPropagation()}>
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
      <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((current) => !current); }} className="task-inline-control" data-interactive="true">
        {selectedAssignee ? <Avatar name={selectedAssignee.user.name} email={selectedAssignee.user.email} imageUrl={selectedAssignee.user.imageUrl} /> : <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><User className="h-3.5 w-3.5" /></span>}
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
                    <Avatar name={assignee.user.name} email={assignee.user.email} imageUrl={assignee.user.imageUrl} />
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

function sameCalendarDay(a: Date | null, b: Date) {
  return Boolean(a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
}

function DatePicker({ value, onChange, displayValue, compact = false }: { value: string; onChange: (value: string) => void; displayValue?: string; compact?: boolean }) {
  const selectedDate = dateFromField(value);
  const initialIncludesTime = Boolean(selectedDate && dateFieldHasTime(value));
  const [open, setOpen] = useState(false);
  const [includeTime, setIncludeTime] = useState(initialIncludesTime);
  const [dateDraft, setDateDraft] = useState(() => selectedDate ? formatDateOnly(selectedDate, "short") : "");
  const [timeDraft, setTimeDraft] = useState(() => initialIncludesTime && selectedDate ? formatTimeOnly(selectedDate) : "");
  const [monthDate, setMonthDate] = useState(() => selectedDate ?? new Date());
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const calendarStart = new Date(monthStart);
  calendarStart.setDate(1 - monthStart.getDay());
  const monthLabel = monthDate.toLocaleString(undefined, { month: "short", year: "numeric" });
  const todayDate = new Date();

  useEffect(() => {
    const nextDate = dateFromField(value);
    const nextIncludesTime = Boolean(nextDate && dateFieldHasTime(value));
    setIncludeTime(nextIncludesTime);
    setDateDraft(nextDate ? formatDateOnly(nextDate, "short") : "");
    setTimeDraft(nextIncludesTime && nextDate ? formatTimeOnly(nextDate) : "");
    if (nextDate) setMonthDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
  }, [value]);

  function emitDate(date: Date, withTime: boolean, timeSource: Date | null = selectedDate) {
    const next = new Date(date);
    if (withTime) {
      const source = timeSource && dateFieldHasTime(value) ? timeSource : new Date();
      next.setHours(source.getHours(), source.getMinutes(), 0, 0);
    } else {
      next.setHours(23, 59, 59, 0);
    }
    onChange(toDateField(next.getTime(), withTime));
  }

  function commitDateDraft() {
    const parsed = dateFromField(dateDraft);
    if (!parsed) {
      setDateDraft(selectedDate ? formatDateOnly(selectedDate, "short") : "");
      return;
    }
    const draftIncludesTime = dateFieldHasTime(dateDraft);
    setMonthDate(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
    if (draftIncludesTime) {
      setIncludeTime(true);
      onChange(toDateField(parsed.getTime(), true));
    } else {
      emitDate(parsed, includeTime);
    }
  }

  function commitTimeDraft() {
    const parts = parseTimeParts(timeDraft);
    if (!parts) {
      setTimeDraft(selectedDate && includeTime ? formatTimeOnly(selectedDate) : "");
      return;
    }
    const next = selectedDate ? new Date(selectedDate) : new Date();
    next.setHours(parts.hours, parts.minutes, 0, 0);
    setIncludeTime(true);
    onChange(toDateField(next.getTime(), true));
  }

  function pick(date: Date) {
    setMonthDate(new Date(date.getFullYear(), date.getMonth(), 1));
    emitDate(date, includeTime);
  }

  function jumpToCurrent() {
    const now = new Date();
    setMonthDate(new Date(now.getFullYear(), now.getMonth(), 1));
    emitDate(now, includeTime, includeTime ? now : null);
  }

  function toggleIncludeTime(nextIncludesTime: boolean) {
    setIncludeTime(nextIncludesTime);
    const date = selectedDate ?? new Date();
    emitDate(date, nextIncludesTime, nextIncludesTime ? (selectedDate && dateFieldHasTime(value) ? selectedDate : new Date()) : null);
  }


  const header = (
    <>
      {!compact && <CalendarDays className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />}
      <span className={cn("min-w-0 flex-1 truncate", !value && "text-[var(--ink-faint)]")}>{displayValue ?? (value || (compact ? "—" : "Add date"))}</span>
      {!compact && <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />}
    </>
  );
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart);
    date.setDate(calendarStart.getDate() + index);
    return date;
  });
  const calendar = (
    <div className="p-3">
      <div className="mb-3 flex items-center gap-1.5">
        <input
          aria-label="Due date"
          className="h-8 min-w-0 flex-1 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-ring)]"
          value={dateDraft}
          onChange={(event) => setDateDraft(event.target.value)}
          onBlur={commitDateDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commitDateDraft(); }
            if (event.key === "Escape") setDateDraft(selectedDate ? formatDateOnly(selectedDate, "short") : "");
          }}
          placeholder="Jun 24, 2026"
        />
        {includeTime && (
          <>
            <input
              aria-label="Due time"
              className="h-8 w-[86px] rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-ring)]"
              value={timeDraft}
              onChange={(event) => setTimeDraft(event.target.value)}
              onBlur={commitTimeDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); commitTimeDraft(); }
                if (event.key === "Escape") setTimeDraft(selectedDate && includeTime ? formatTimeOnly(selectedDate) : "");
              }}
              placeholder="5:00 PM"
            />
          </>
        )}
      </div>
      <div className="mb-2 flex items-center gap-1.5">
        <div className="flex-1 text-[13px] font-semibold text-[var(--ink)]">{monthLabel}</div>
        <button type="button" className="rounded-md px-2 py-1 text-[12px] font-medium text-[var(--ink-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]" onClick={jumpToCurrent}>{includeTime ? "Now" : "Today"}</button>
        <button type="button" className="task-icon-btn h-7 w-7" onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" className="task-icon-btn h-7 w-7" onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-[var(--ink-faint)]">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <div key={day} className="py-1">{day}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {calendarDays.map((date) => {
          const selected = sameCalendarDay(selectedDate, date);
          const inCurrentMonth = date.getMonth() === monthDate.getMonth();
          const isToday = sameCalendarDay(todayDate, date);
          return (
            <button key={date.toISOString()} type="button" onClick={() => pick(date)} className={cn("h-8 rounded-md text-[13px] transition-colors hover:bg-[var(--surface-muted)]", inCurrentMonth ? "text-[var(--ink-secondary)]" : "text-[var(--ink-faint)]", isToday && "font-semibold text-[var(--primary)]", selected && "bg-[var(--primary)] !text-[var(--on-primary)] hover:!bg-[var(--primary-hover)]")}>
              {date.getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-3 border-t border-[var(--hairline)] py-2">
        <button type="button" role="switch" aria-checked={includeTime} className="flex w-full items-center justify-between rounded-md px-0 py-1.5 text-left text-[13px] text-[var(--ink-secondary)] hover:text-[var(--ink)]" onClick={() => toggleIncludeTime(!includeTime)}>
          <span>Include time</span>
          <span className={cn("relative h-5 w-9 rounded-full transition-colors", includeTime ? "bg-[var(--primary)]" : "bg-[var(--surface-pressed)]")}>
            <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", includeTime ? "translate-x-[18px]" : "translate-x-0.5")} />
          </span>
        </button>
      </div>
      <div className="border-t border-[var(--hairline)] pt-1">
        <button type="button" className="w-full rounded-md py-1.5 text-left text-[13px] text-[var(--ink-secondary)] hover:text-[var(--ink)]" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>
      </div>
    </div>
  );

  if (compact) return <TaskCellPopover open={open} onOpenChange={setOpen} ariaLabel="Change due date" header={header} panelClassName="task-cell-popover-date">{calendar}</TaskCellPopover>;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-inline-control" data-interactive="true" onClick={(event) => event.stopPropagation()}>{header}</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="task-menu w-[250px] p-0" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          {calendar}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function InlineTextCell({ value, placeholder = "—", ariaLabel, onSave, required = false, inputMode = "text", align = "left", pending = false }: { value: string; placeholder?: string; ariaLabel: string; onSave: (value: string) => Promise<boolean>; required?: boolean; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; align?: "left" | "right"; pending?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const savingRef = useRef(false);
  const didFocusRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [editing, value]);
  useEffect(() => { if (!editing) didFocusRef.current = false; }, [editing]);
  useLayoutEffect(() => {
    if (!editing || !textareaRef.current) return;
    const textarea = textareaRef.current;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(41, textarea.scrollHeight + 2)}px`;
  }, [draft, editing]);

  async function commit() {
    if (savingRef.current) return;
    const next = draft.trim();
    if (required && !next) { setDraft(value); setEditing(false); return; }
    if (next === value.trim()) { setEditing(false); return; }
    savingRef.current = true;
    const saved = await onSave(next);
    savingRef.current = false;
    if (saved) setEditing(false);
    else setDraft(value);
  }

  if (editing) {
    return (
      <span className="task-cell-editor" data-interactive="true">
        <span aria-hidden="true" className={cn("task-cell-control task-cell-editor-sizer", align === "right" && "justify-end text-right")}>
          <span className={cn("min-w-0 truncate", !value && "text-[var(--ink-faint)]")}>{value || placeholder}</span>
        </span>
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          autoFocus
          data-interactive="true"
          inputMode={inputMode}
          disabled={pending}
          value={draft}
          rows={1}
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
          className={cn("task-cell-input", align === "right" && "text-right")}
        />
      </span>
    );
  }

  return (
    <button type="button" data-interactive="true" disabled={pending} className={cn("task-cell-control", align === "right" && "justify-end text-right", pending && "opacity-60")} onClick={(event) => { event.stopPropagation(); setEditing(true); }}>
      <span className={cn("min-w-0 truncate", !value && "text-[var(--ink-faint)]")}>{value || placeholder}</span>
    </button>
  );
}

function InlineSelectCell<T extends string>({ value, options, ariaLabel, onSave, pending = false, renderValue }: { value: T; options: { value: T; label: string }[]; ariaLabel: string; onSave: (value: T) => Promise<boolean>; pending?: boolean; renderValue?: (option: { value: T; label: string } | undefined) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const header = <span className="min-w-0 flex-1 truncate">{renderValue ? renderValue(selected) : selected?.label ?? "—"}</span>;
  return (
    <TaskCellPopover open={open} onOpenChange={setOpen} disabled={pending} pending={pending} ariaLabel={ariaLabel} header={header}>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => { setOpen(false); if (option.value !== value) void onSave(option.value); }} className="task-cell-popover-item">
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.value === value && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
        </button>
      ))}
    </TaskCellPopover>
  );
}

function InlineAssigneeCell({ assignable, assignees, selected, onSave, pending = false }: { assignable: any[]; assignees: any[]; selected: string[]; onSave: (ids: string[]) => Promise<boolean>; pending?: boolean }) {
  const [open, setOpen] = useState(false);
  const selectedId = selected[0];
  const header = <span className="min-w-0 flex-1 truncate"><AvatarStack assignees={assignees} showName /></span>;
  return (
    <TaskCellPopover open={open} onOpenChange={setOpen} disabled={pending || assignable.length === 0} pending={pending} ariaLabel="Change assignee" header={header} panelClassName="task-cell-popover-scroll">
      {assignable.map((assignee) => {
        const id = assignee.membership._id as string;
        const name = assignee.user.name || assignee.user.email;
        return (
          <button key={id} type="button" onClick={() => { setOpen(false); if (id !== selectedId) void onSave([id]); }} className="task-cell-popover-item">
            <Avatar name={assignee.user.name} email={assignee.user.email} imageUrl={assignee.user.imageUrl} />
            <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--ink)]">{name}</span><span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{assignee.membership.role}</span></span>
            {selectedId === id && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
          </button>
        );
      })}
    </TaskCellPopover>
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
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pendingCell, setPendingCell] = useState<string | null>(null);
  const canUseAllTasks = active?.membership.role === "Admin" || active?.membership.role === "Manager";
  const assignable = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: taskTypeFor(kind) } : "skip") as any[] | undefined;
  const filterableAssignees = useQuery(api.tasks.filterableAssignees, activeCompanyId && canUseAllTasks ? { companyId: activeCompanyId } : "skip") as any[] | undefined;
  const tasks = useQuery(kind === "jd" ? api.tasks.listJdRows : api.tasks.listOneTimeRows, activeCompanyId ? (kind === "jd" ? { companyId: activeCompanyId, search: search || undefined, frequency, sort: "newest" as const } : { companyId: activeCompanyId, search: search || undefined, sort: "newest" as const }) : "skip") as any[] | undefined;
  const updateJd = useMutation(api.tasks.updateJd);
  const updateOneTime = useMutation(api.tasks.updateOneTime);
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

  async function saveInline(task: any, patch: Partial<TaskFormValues>, label: string) {
    if (!activeCompanyId) return false;
    const key = `${task._id}:${label}`;
    setPendingCell(key);
    setInlineError(null);
    try {
      const common = {
        companyId: activeCompanyId,
        title: (patch.title ?? task.title ?? "").trim(),
        description: patch.description ?? task.description,
        time: patch.time ?? task.time,
        quantity: patch.quantity !== undefined ? quantityFromInput(patch.quantity) : task.quantity,
        assigneeMembershipIds: (patch.assigneeMembershipIds ?? task.assigneeMembershipIds) as Id<"companyMemberships">[],
      };
      if (kind === "jd") await updateJd({ ...common, taskId: task._id as Id<"jdTasks">, recurrence: (patch.recurrence ?? task.recurrence) as Frequency });
      else await updateOneTime({ ...common, taskId: task._id as Id<"oneTimeTasks">, dueDate: patch.dueDate !== undefined ? fromDateInput(patch.dueDate) : task.dueDate, priority: (patch.priority ?? task.priority) as Priority });
      return true;
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : "Could not update the task.");
      return false;
    } finally {
      setPendingCell((current) => current === key ? null : current);
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

      {inlineError && (
        <div className="alert-error mb-3 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]" role="alert">
          <span>{inlineError}</span>
          <button type="button" className="task-icon-btn h-6 w-6" onClick={() => setInlineError(null)} aria-label="Dismiss inline edit error"><X className="h-3.5 w-3.5" /></button>
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
                <th><span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />Due Date</span></th>
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
                  const rowCanEdit = canEditTaskRow(active, kind, task);
                  const pending = (field: string) => pendingCell === `${task._id}:${field}`;
                  const openDetails = () => router.push(`${base}/${task._id}`);
                  return (
                    <tr
                      key={task._id}
                      data-row="task"
                      data-clickable={!rowCanEdit ? "true" : undefined}
                      data-selected={task._id === selectedId}
                      data-checked={isChecked ? "true" : undefined}
                      tabIndex={!rowCanEdit ? 0 : undefined}
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
                      <td className="col-task max-w-[250px]">
                        <div className="task-title-cell">
                          {rowCanEdit ? (
                            <InlineTextCell value={task.title ?? ""} ariaLabel="Edit task title" required pending={pending("title")} onSave={(title) => saveInline(task, { title }, "title")} />
                          ) : (
                            <div className="flex min-w-0 items-center gap-2.5"><span className="min-w-0 flex-1 truncate">{task.title}</span></div>
                          )}
                          <button
                            type="button"
                            data-interactive="true"
                            data-tooltip="Open in side peek"
                            className="task-title-open"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => { event.stopPropagation(); openDetails(); }}
                            aria-label={`Open details for ${task.title}`}
                          >
                            <PanelRight className="h-3.5 w-3.5" />
                            <span>OPEN</span>
                          </button>
                        </div>
                      </td>
                      {kind === "jd" ? (
                        <td className="whitespace-nowrap text-[var(--ink-secondary)]">
                          {rowCanEdit ? (
                            <InlineSelectCell value={task.recurrence as Frequency} options={frequencies} ariaLabel="Change frequency" pending={pending("frequency")} onSave={(recurrence) => saveInline(task, { recurrence }, "frequency")} />
                          ) : frequencyLabel(task.recurrence)}
                        </td>
                      ) : (
                        <td>
                          {rowCanEdit && canEditPriority(active) ? (
                            <InlineSelectCell
                              value={task.priority as Priority}
                              options={priorities.map((priority) => ({ value: priority, label: priorityLabel(priority) }))}
                              ariaLabel="Change priority"
                              pending={pending("priority")}
                              onSave={(priority) => saveInline(task, { priority }, "priority")}
                              renderValue={(option) => <span className={cn("priority-chip", priorityChipClasses((option?.value ?? task.priority) as Priority))}>{option?.label ?? priorityLabel(task.priority)}</span>}
                            />
                          ) : (
                            <span className={cn("priority-chip", priorityChipClasses(task.priority))}>{priorityLabel(task.priority)}</span>
                          )}
                        </td>
                      )}
                      <td>
                        {rowCanEdit && assignable ? (
                          <InlineAssigneeCell assignable={assignable} assignees={task.assignees} selected={task.assigneeMembershipIds ?? []} pending={pending("assignee")} onSave={(assigneeMembershipIds) => saveInline(task, { assigneeMembershipIds }, "assignee")} />
                        ) : <AvatarStack assignees={task.assignees} showName />}
                      </td>
                      <td><StatusBadge kind={kind} task={task} canUpdateOverride={rowCanEdit} cellTrigger={rowCanEdit} /></td>
                      {kind === "one" && (
                        <td className="whitespace-nowrap">
                          {rowCanEdit ? (
                            <DatePicker value={task.dueDate ? toDateField(task.dueDate, dateHasExplicitTime(task.dueDate)) : ""} displayValue={dueLabel(task)} compact onChange={(dueDate) => { void saveInline(task, { dueDate }, "due"); }} />
                          ) : (
                            <span className={cn(dueTone(task) === "danger" && "font-medium text-[var(--danger)]", dueTone(task) === "warn" && "font-medium text-[var(--badge-yellow-fg)]", dueTone(task) === "muted" && "text-[var(--ink-faint)]")}>{dueLabel(task)}</span>
                          )}
                        </td>
                      )}
                      <td>
                        {rowCanEdit ? <InlineTextCell value={task.time ?? ""} ariaLabel="Edit time" pending={pending("time")} onSave={(time) => saveInline(task, { time }, "time")} /> : (task.time || "—")}
                      </td>
                      <td>
                        {rowCanEdit ? <InlineTextCell value={task.quantity != null ? String(task.quantity) : ""} ariaLabel="Edit quantity" inputMode="decimal" pending={pending("quantity")} onSave={(quantity) => saveInline(task, { quantity }, "quantity")} /> : (task.quantity != null ? task.quantity : "—")}
                      </td>
                    </tr>
                  );
                })}
                {canCreate && (
                  <tr className="task-add-row">
                    <td colSpan={kind === "jd" ? jdColumns : oneColumns}>
                      <button type="button" className="task-add-label inline-flex items-center gap-1.5" onClick={() => setCreateOpen(true)}>
                        <Plus className="h-3.5 w-3.5" />New task
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
  );
}

function EditableTaskText({ value, placeholder, ariaLabel, canEdit, required = false, variant, onSave }: { value: string; placeholder: string; ariaLabel: string; canEdit: boolean; required?: boolean; variant: "title" | "description"; onSave: (value: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestValueRef = useRef(value);
  const draftRef = useRef(value);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const lastSentRef = useRef<string | null>(null);

  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => {
    latestValueRef.current = value;
    if (value.trim() === lastSentRef.current) lastSentRef.current = null;
    if (!focused && !savingRef.current) setDraft(value);
  }, [focused, value]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  const persist = useCallback(async function persistCurrent() {
    if (!canEdit) return;
    const next = draftRef.current.trim();
    if (required && !next) {
      setSaveState("error");
      setError("Title is required.");
      return;
    }
    if (next === latestValueRef.current.trim() || next === lastSentRef.current) return;
    if (savingRef.current) {
      queuedRef.current = true;
      return;
    }

    savingRef.current = true;
    setSaveState("saving");
    setError(null);
    const saved = await onSave(next);
    savingRef.current = false;

    if (!saved) {
      lastSentRef.current = null;
      queuedRef.current = false;
      setDraft(latestValueRef.current);
      setSaveState("error");
      setError("Could not save.");
      return;
    }

    lastSentRef.current = next;
    setSaveState("saved");
    window.setTimeout(() => setSaveState((current) => current === "saved" ? "idle" : current), 1200);
    if (queuedRef.current || draftRef.current.trim() !== next) {
      queuedRef.current = false;
      void persistCurrent();
    }
  }, [canEdit, onSave, required]);

  useEffect(() => {
    if (!canEdit || draft.trim() === latestValueRef.current.trim()) return;
    const timer = window.setTimeout(() => { void persist(); }, 800);
    return () => window.clearTimeout(timer);
  }, [canEdit, draft, persist]);

  if (!canEdit) {
    if (variant === "title") return <h1 className="text-[26px] font-bold leading-tight tracking-[-0.025em] text-[var(--ink)]">{value}</h1>;
    return value ? <p className="whitespace-pre-wrap text-[14px] leading-7 text-[var(--ink-secondary)]">{value}</p> : <p className="text-[14px] leading-7 text-[var(--ink-faint)]">{placeholder}</p>;
  }

  return (
    <div className="task-detail-editable-wrap">
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        aria-label={ariaLabel}
        placeholder={placeholder}
        data-editable="true"
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); void persist(); }}
        onChange={(event) => { setDraft(event.target.value); setError(null); if (saveState === "error") setSaveState("idle"); }}
        onKeyDown={(event) => {
          if (variant === "title" && event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setDraft(latestValueRef.current); setError(null); setSaveState("idle"); event.currentTarget.blur(); }
        }}
        className={cn("task-detail-editable", variant === "title" ? "task-detail-editable-title" : "task-detail-editable-description")}
      />
      {(saveState === "saving" || saveState === "saved" || error) && (
        <div className="task-detail-save-state" data-error={error ? "true" : undefined} aria-live="polite">
          {error ?? (saveState === "saving" ? "Saving..." : "Saved")}
        </div>
      )}
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
    <div className="grid gap-1.5">
      {attachments.map((attachment) => (
        <div key={attachment._id} className="task-attachment-item group">
          <Paperclip className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
          <a className="min-w-0 flex-1 truncate hover:text-[var(--ink)]" href={attachment.url ?? "#"} target="_blank" rel="noreferrer" title={`${attachment.fileName} · ${humanSize(attachment.size)}${attachment.createdAt ? ` · ${formatDate(attachment.createdAt)}` : ""}`}>
            {attachment.fileName}
          </a>
          {canDelete && <button type="button" className="task-icon-btn h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onDelete(attachment._id)} aria-label={`Delete ${attachment.fileName}`}><Trash2 className="h-3.5 w-3.5" /></button>}
        </div>
      ))}
    </div>
  );
}

function PeekBar({ kind, canEdit, onEdit }: { kind: Kind; canEdit: boolean; onEdit: () => void }) {
  const router = useRouter();
  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";

  return (
    <div className="peek-bar -mt-7 -mx-6 px-2 md:-mt-8 md:-mx-9 md:px-3">
      <div className="flex items-center gap-1">
        <button type="button" className="task-icon-btn" aria-label="Close details" onClick={() => router.push(base)}>
          <ChevronsRight className="h-5 w-5" />
        </button>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1">
          <button type="button" className="task-icon-btn" aria-label="Edit task" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export function TaskDetail({ kind, id }: { kind: Kind; id: string }) {
  const { activeCompanyId, active, email } = useCompany();
  const taskType = taskTypeFor(kind);
  const data = useQuery(kind === "jd" ? api.tasks.getJd : api.tasks.getOneTime, activeCompanyId ? { companyId: activeCompanyId, taskId: id as any } : "skip") as any;
  const assignable = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: taskType } : "skip") as any[] | undefined;
  const commentsQuery = usePaginatedQuery(api.tasks.listComments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip", { initialNumItems: 25 });
  const attachmentsQuery = usePaginatedQuery(api.tasks.listAttachments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip", { initialNumItems: 25 });
  const attachments = attachmentsQuery.results as any[] | undefined;
  const comment = useMutation(api.tasks.addComment);
  const updateComment = useMutation(api.tasks.updateComment);
  const deleteComment = useMutation(api.tasks.deleteComment);
  const generateUploadUrl = useMutation(api.tasks.generateAttachmentUploadUrl);
  const addAttachment = useMutation(api.tasks.addAttachment);
  const deleteAttachment = useMutation(api.tasks.deleteAttachment);
  const updateJdText = useMutation(api.tasks.updateJdText);
  const updateOneTimeText = useMutation(api.tasks.updateOneTimeText);
  const [editOpen, setEditOpen] = useState(false);
  const [body, setBody] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [optimisticComments, setOptimisticComments] = useState<any[]>([]);
  const [optimisticCommentBodies, setOptimisticCommentBodies] = useState<Record<string, string>>({});
  const [optimisticDeletedCommentIds, setOptimisticDeletedCommentIds] = useState<string[]>([]);
  const [editingCommentId, setEditingCommentId] = useState<Id<"taskComments"> | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editCommentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previousEditingCommentIdRef = useRef<Id<"taskComments"> | null>(null);

  const comments = useMemo(() => [...(((commentsQuery.results as any[]) ?? []).slice().reverse()).filter((commentRow) => !optimisticDeletedCommentIds.includes(commentRow._id)).map((commentRow) => ({ ...commentRow, body: optimisticCommentBodies[commentRow._id] ?? commentRow.body })), ...optimisticComments], [commentsQuery.results, optimisticCommentBodies, optimisticComments, optimisticDeletedCommentIds]);
  const canManageAttachments = active?.capabilities.includes("tasks:attachment:add") ?? false;
  const canComment = active?.capabilities.includes("tasks:comment") ?? false;
  const canEdit = Boolean(data?.canUpdate);

  useLayoutEffect(() => {
    const textarea = commentTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [body]);

  useLayoutEffect(() => {
    if (!editingCommentId) {
      previousEditingCommentIdRef.current = null;
      return;
    }
    const textarea = editCommentTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    if (previousEditingCommentIdRef.current !== editingCommentId) {
      textarea.focus();
      textarea.setSelectionRange(editingCommentBody.length, editingCommentBody.length);
    }
    previousEditingCommentIdRef.current = editingCommentId;
  }, [editingCommentBody, editingCommentId]);

  if (!data) return <TaskDetailSkeleton />;
  const task = data.task;

  async function saveTaskText(patch: { title?: string; description?: string }) {
    if (!activeCompanyId) return false;
    setTextError(null);
    try {
      if (kind === "jd") await updateJdText({ companyId: activeCompanyId, taskId: task._id as Id<"jdTasks">, ...patch });
      else await updateOneTimeText({ companyId: activeCompanyId, taskId: task._id as Id<"oneTimeTasks">, ...patch });
      return true;
    } catch (err) {
      setTextError(err instanceof Error ? err.message : "Could not update the task.");
      return false;
    }
  }

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

  async function submitComment() {
    const text = body.trim();
    if (!text || !activeCompanyId) return;
    const tempId = crypto.randomUUID();
    setActionError(null);
    setOptimisticComments((current) => [{ _id: tempId, body: text, createdAt: Date.now(), optimistic: true }, ...current]);
    setBody("");
    try {
      await comment({ companyId: activeCompanyId, taskType, taskId: id, body: text });
    } catch (err) {
      setBody(text);
      setActionError(err instanceof Error ? err.message : "Could not add comment.");
    } finally {
      setOptimisticComments((current) => current.filter((commentRow) => commentRow._id !== tempId));
    }
  }

  function startEditingComment(commentRow: any) {
    setActionError(null);
    setEditingCommentId(commentRow._id);
    setEditingCommentBody(commentRow.body);
  }

  function cancelEditingComment() {
    setEditingCommentId(null);
    setEditingCommentBody("");
  }

  async function saveEditedComment(commentId: Id<"taskComments">) {
    const text = editingCommentBody.trim();
    if (!text || !activeCompanyId) return;
    const previousBody = comments.find((commentRow) => commentRow._id === commentId)?.body ?? "";
    setActionError(null);
    setOptimisticCommentBodies((current) => ({ ...current, [commentId]: text }));
    cancelEditingComment();
    try {
      await updateComment({ companyId: activeCompanyId, commentId, body: text });
      setOptimisticCommentBodies((current) => { const next = { ...current }; delete next[commentId]; return next; });
    } catch (err) {
      setOptimisticCommentBodies((current) => ({ ...current, [commentId]: previousBody }));
      setActionError(err instanceof Error ? err.message : "Could not update comment.");
    }
  }

  async function removeComment(commentId: Id<"taskComments">) {
    if (!activeCompanyId) return;
    setActionError(null);
    setOptimisticDeletedCommentIds((current) => current.includes(commentId) ? current : [...current, commentId]);
    if (editingCommentId === commentId) cancelEditingComment();
    try {
      await deleteComment({ companyId: activeCompanyId, commentId });
    } catch (err) {
      setOptimisticDeletedCommentIds((current) => current.filter((id) => id !== commentId));
      setActionError(err instanceof Error ? err.message : "Could not delete comment.");
    }
  }

  const primaryAssignee = task.assignees?.[0];

  return (
    <div>
      <PeekBar kind={kind} canEdit={canEdit} onEdit={() => setEditOpen(true)} />
      <TaskDialog kind={kind} mode="edit" open={editOpen} onOpenChange={setEditOpen} task={task} assignable={assignable ?? []} />

      {textError && <p className="alert-error mt-4 rounded-md p-2 text-[13px]" role="alert">{textError}</p>}

      <div className="pt-6">
        <EditableTaskText value={task.title ?? ""} placeholder="Untitled task" ariaLabel="Edit task title" canEdit={canEdit} required variant="title" onSave={(title) => saveTaskText({ title })} />
      </div>

      <div className="task-section !mt-6">
        <div className="prop-list">
          <PropertyRow icon={<UsersIcon className="h-3.5 w-3.5" />} label="Assignee" muted={!task.assignees?.length}>
            {task.assignees?.length ? (
              <span className="inline-flex items-center gap-2">
                {primaryAssignee && <Avatar name={primaryAssignee.user.name} email={primaryAssignee.user.email} imageUrl={primaryAssignee.user.imageUrl} />}
                <span className="truncate">{primaryAssignee?.user.name || primaryAssignee?.user.email}</span>
                {task.assignees.length > 1 && <span className="text-[var(--ink-faint)]">+{task.assignees.length - 1}</span>}
              </span>
            ) : "Unassigned"}
          </PropertyRow>
          <PropertyRow icon={<StatusIcon className="h-3.5 w-3.5" />} label="Status">
            <StatusBadge kind={kind} task={task} size="md" canUpdateOverride={canEdit} />
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
        <EditableTaskText value={task.description ?? ""} placeholder={canEdit ? "Add description..." : "No description."} ariaLabel="Edit task description" canEdit={canEdit} variant="description" onSave={(description) => saveTaskText({ description })} />
      </section>

      <section className="task-section">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="task-section-title !mb-0">Attachments</h2>
          {attachmentsQuery.status === "CanLoadMore" && <Button size="sm" variant="ghost" onClick={() => attachmentsQuery.loadMore(25)}>Load more</Button>}
        </div>
        <AttachmentList attachments={attachments ?? []} canDelete={canManageAttachments} onDelete={(attachmentId) => deleteAttachment({ companyId: activeCompanyId as Id<"companies">, attachmentId })} />
        {uploadError && <p className="alert-error mt-3 rounded-md p-2 text-[13px]">{uploadError}</p>}
        {canManageAttachments && (
          <div className="task-attachment-add-row">
            <label className="task-attachment-add inline-flex cursor-pointer items-center gap-1.5">
              <input className="sr-only" type="file" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} />
              <Plus className="h-3.5 w-3.5" />{uploading ? "Uploading..." : "Attach file"}
            </label>
          </div>
        )}
      </section>

      <section className="task-section">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[var(--ink-muted)]">Comments</h2>
          {commentsQuery.status === "CanLoadMore" && <Button size="sm" variant="ghost" onClick={() => commentsQuery.loadMore(25)}>Load more</Button>}
        </div>
        {comments.length > 0 && (
          <div className="mb-5">
            {comments.map((commentRow: any, index) => {
              const name = commentRow.author?.user.name || commentRow.author?.user.email || "You";
              const isLastComment = index === comments.length - 1;
              const isEditing = editingCommentId === commentRow._id;
              const canManageComment = canComment && !commentRow.optimistic && active?.membership._id === commentRow.authorMembershipId;
              return (
                <div key={commentRow._id} className={cn("comment-row relative flex gap-2.5", !isLastComment && "pb-4")} data-editing={isEditing ? "true" : undefined}>
                  {canManageComment && (
                    <div className="comment-action-menu">
                      {isEditing ? (
                        <>
                          <button type="button" className="comment-action-btn" aria-label="Cancel editing comment" onClick={cancelEditingComment}><X className="h-3.5 w-3.5" /></button>
                          <button type="button" className="comment-action-btn" aria-label="Save comment" disabled={!editingCommentBody.trim()} onClick={() => void saveEditedComment(commentRow._id)}><Check className="h-3.5 w-3.5" /></button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="comment-action-btn" aria-label="Edit comment" onClick={() => startEditingComment(commentRow)}><Pencil className="h-3.5 w-3.5" /></button>
                          <button type="button" className="comment-action-btn" aria-label="Delete comment" onClick={() => void removeComment(commentRow._id)}><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      )}
                    </div>
                  )}
                  {!isLastComment && <span className="absolute bottom-[6px] left-3 top-[30px] w-px -translate-x-1/2 bg-[color-mix(in_srgb,var(--hairline-strong)_72%,var(--ink-faint))]" aria-hidden />}
                  <div className="relative z-[1] flex w-6 shrink-0 justify-center">
                    <Avatar name={commentRow.author?.user.name ?? null} email={commentRow.author?.user.email ?? null} imageUrl={commentRow.author?.user.imageUrl ?? null} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[13px] font-medium text-[var(--ink)]">{name}</span>
                      {commentRow.createdAt && <span className="text-[12px] text-[var(--ink-faint)]">{relativeTime(commentRow.createdAt)}</span>}
                    </div>
                    {isEditing ? (
                      <textarea
                        ref={editCommentTextareaRef}
                        rows={1}
                        value={editingCommentBody}
                        onChange={(event) => setEditingCommentBody(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") cancelEditingComment();
                          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void saveEditedComment(commentRow._id); }
                        }}
                        className="mt-0.5 block min-h-6 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[13px] leading-6 text-[var(--ink-secondary)] outline-none"
                        autoFocus
                      />
                    ) : (
                      <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-6 text-[var(--ink-secondary)]">{commentRow.body}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {canComment && (
          <form className="group flex items-start gap-2 border-b border-[var(--hairline)] pb-3" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--hairline)] bg-[var(--canvas-soft)] text-[11px] text-[var(--ink-muted)]">
              {initials(null, email).slice(0, 1)}
            </span>
            <textarea
              ref={commentTextareaRef}
              rows={1}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitComment(); } }}
              placeholder="Add a comment..."
              className="min-h-6 max-h-24 flex-1 resize-none overflow-y-auto border-0 bg-transparent p-0 text-[13px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
            />
            <button type="submit" disabled={!body.trim()} className={cn("hidden h-5 w-5 shrink-0 place-items-center rounded-full text-[var(--on-primary)] transition-colors group-focus-within:grid", body.trim() ? "bg-[var(--primary)] hover:bg-[var(--primary-hover)]" : "bg-[var(--ink-faint)] disabled:opacity-30")} aria-label="Add comment">
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </form>
        )}
        {actionError && <p className="alert-error mt-3 rounded-md p-2 text-[13px]">{actionError}</p>}
      </section>
    </div>
  );
}
