"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMutation, useQuery } from "convex/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Check, ChevronDown, ChevronRight, ChevronsRight, CircleAlert, Copy, Loader2, MessageCirclePlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { safeActivityLabel, safeCompletedActivityLabel } from "@/lib/ai/activity";
import { textOf, toUiMessage } from "@/lib/message-utils";

type ActivityState = "running" | "done" | "error";

type ActivityItem = {
  id: string;
  toolName: string;
  activeLabel: string;
  completedLabel: string;
  state: ActivityState;
  detail?: string;
  meta?: string;
};

type ActivityThought = {
  id: string;
  text: string;
  state: Exclude<ActivityState, "error">;
};

type ActivityEntry =
  | { kind: "thought"; thought: ActivityThought }
  | { kind: "action"; item: ActivityItem };

type ActivitySegment = {
  id: string;
  entries: ActivityEntry[];
  title: string;
  isLive: boolean;
  isDefaultThought?: boolean;
};

type AssistantBlock =
  | { kind: "activity"; segment: ActivitySegment }
  | { kind: "text"; id: string; text: string };

type ActivityPanelPreference = { open: boolean; manual: boolean };

type ChatSession = { _id: Id<"aiChatSessions">; title?: string; createdAt: number; updatedAt: number };

const AI_SESSION_RESTORE_TTL_MS = 5 * 60 * 60 * 1000;

function aiSessionStorageKey(companyId: Id<"companies">) {
  return `cendro:ai-session:${companyId}`;
}

function readStoredAiSession(companyId: Id<"companies">) {
  try {
    const raw = sessionStorage.getItem(aiSessionStorageKey(companyId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as { sessionId?: Id<"aiChatSessions">; updatedAt?: number };
    if (!stored.sessionId || !stored.updatedAt || Date.now() - stored.updatedAt > AI_SESSION_RESTORE_TTL_MS) {
      sessionStorage.removeItem(aiSessionStorageKey(companyId));
      return null;
    }
    return stored.sessionId;
  } catch {
    return null;
  }
}

function rememberStoredAiSession(companyId: Id<"companies">, sessionId: Id<"aiChatSessions">) {
  try {
    sessionStorage.setItem(aiSessionStorageKey(companyId), JSON.stringify({ sessionId, updatedAt: Date.now() }));
  } catch {
    // Ignore unavailable sessionStorage.
  }
}

function sessionLabel(session?: { title?: string } | null) {
  return session?.title?.trim() || "New Session";
}

function toolNameOfPart(part: any) {
  const type = String(part?.type ?? "");
  if (type.startsWith("tool-")) return type.slice(5);
  if (type === "dynamic-tool") return String(part.toolName ?? "");
  return "";
}

function activityStateOfPart(part: any): ActivityItem["state"] {
  if (part?.state === "output-error" || part?.state === "output-denied") return "error";
  if (part?.state === "output-available") return "done";
  return "running";
}

function compactActivityText(value: unknown, maxLength = 180) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function hostnameOf(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function activityDetailOfPart(part: any, toolName: string) {
  const input = part?.input;
  if (toolName === "web_search" || toolName === "search_sops") return compactActivityText(input?.query);
  if (toolName === "web_fetch") return hostnameOf(input?.url) ?? compactActivityText(input?.url);
  return undefined;
}

function activityMetaOfPart(part: any, toolName: string) {
  const output = part?.output;
  if (toolName === "web_search" && Array.isArray(output?.results)) {
    const count = output.results.length;
    return count === 1 ? "1 result" : `${count} results`;
  }
  if (toolName === "web_fetch") return compactActivityText(output?.page?.title, 80);
  return undefined;
}

function activityItemOfPart(part: any): ActivityItem | null {
  const toolName = toolNameOfPart(part);
  if (!toolName) return null;
  const title = typeof part.title === "string" && part.title.trim() ? part.title.trim() : null;
  return {
    id: String(part.toolCallId ?? `${toolName}:${part.state ?? "pending"}`),
    toolName,
    activeLabel: title ?? safeActivityLabel(toolName),
    completedLabel: title ?? safeCompletedActivityLabel(toolName),
    state: activityStateOfPart(part),
    detail: activityDetailOfPart(part, toolName),
    meta: activityMetaOfPart(part, toolName),
  };
}

function activitySummary(entries: ActivityEntry[]) {
  const actions = entries.flatMap((entry) => entry.kind === "action" ? [entry.item] : []);
  if (!actions.length) return "Thought";
  const labels = actions.map((item) => item.completedLabel);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]}, ${labels[1].charAt(0).toLowerCase()}${labels[1].slice(1)}`;
  return `${labels[0]}, ${labels[1].charAt(0).toLowerCase()}${labels[1].slice(1)}, +${labels.length - 2} more`;
}

function buildAssistantBlocks(message: any, isLiveMessage: boolean): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const parts = Array.isArray(message.parts) ? message.parts : [];
  let currentEntries: ActivityEntry[] = [];
  let activityIndex = 0;
  let textIndex = 0;
  let thoughtIndex = 0;

  function pushActivity(entries: ActivityEntry[], isDefaultThought = false) {
    const id = `${message.id}:activity:${activityIndex++}`;
    blocks.push({
      kind: "activity",
      segment: {
        id,
        entries,
        title: isDefaultThought ? "Thought" : activitySummary(entries),
        isLive: false,
        isDefaultThought,
      },
    });
  }

  for (const part of parts) {
    if (part?.type === "reasoning") {
      const text = String(part.text ?? "");
      if (text.trim()) {
        currentEntries.push({
          kind: "thought",
          thought: {
            id: `${message.id}:thought:${thoughtIndex++}`,
            text,
            state: part.state === "streaming" ? "running" : "done",
          },
        });
      }
      continue;
    }

    const item = activityItemOfPart(part);
    if (item) {
      currentEntries.push({ kind: "action", item });
      continue;
    }

    if (part?.type === "step-start") continue;

    if (part?.type === "text") {
      const text = String(part.text ?? "");
      if (!text.trim()) continue;
      if (currentEntries.length) {
        pushActivity(currentEntries);
        currentEntries = [];
      }
      blocks.push({ kind: "text", id: `${message.id}:text:${textIndex++}`, text });
    }
  }

  if (currentEntries.length) pushActivity(currentEntries);

  let lastActivityIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].kind === "activity") {
      lastActivityIndex = index;
      break;
    }
  }
  return blocks.map((block, index) => {
    if (block.kind !== "activity") return block;
    const hasRunningEntry = block.segment.entries.some((entry) => entry.kind === "action" ? entry.item.state === "running" : entry.thought.state === "running");
    const hasVisibleEntry = block.segment.entries.length > 0;
    return {
      ...block,
      segment: {
        ...block.segment,
        isLive: isLiveMessage && index === lastActivityIndex && (hasRunningEntry || hasVisibleEntry || !block.segment.isDefaultThought),
      },
    };
  });
}

function ThinkingDot() {
  return (
    <span className="relative grid h-3.5 w-3.5 shrink-0 place-items-center" aria-hidden="true">
      <span className="absolute h-2 w-2 animate-ping rounded-full bg-[var(--ink-faint)] opacity-30" />
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--ink-faint)]" />
    </span>
  );
}

function PendingThinkingIndicator() {
  return (
    <div className="mr-7 px-1 py-1 text-xs text-[var(--ink-muted)]">
      <div className="flex items-center gap-2 rounded-md px-1 py-1.5">
        <ThinkingDot />
        <span className="font-medium">Thinking</span>
        <span className="flex gap-0.5 text-[var(--ink-faint)]" aria-hidden="true">
          <span className="animate-pulse">.</span>
          <span className="animate-pulse [animation-delay:120ms]">.</span>
          <span className="animate-pulse [animation-delay:240ms]">.</span>
        </span>
      </div>
    </div>
  );
}

function formatMessageTime(value: unknown) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return undefined;
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(timestamp));
}

function sessionDateBuckets(now: number) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const week = new Date(todayStart);
  week.setDate(week.getDate() - week.getDay());
  const weekStart = week.getTime();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  return { todayStart, yesterdayStart, weekStart, monthStart };
}

function sessionDateBucket(updatedAt: number, now: number) {
  const { todayStart, yesterdayStart, weekStart, monthStart } = sessionDateBuckets(now);
  if (updatedAt >= todayStart) return "today";
  if (updatedAt >= yesterdayStart) return "yesterday";
  if (updatedAt >= weekStart) return "thisWeek";
  if (updatedAt >= monthStart) return "thisMonth";
  return "older";
}

function CopyMessageButton({ text, align, sentAt }: { text: string; align: "left" | "right"; sentAt?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`pointer-events-none absolute bottom-0 z-10 flex h-7 items-center gap-1 text-[var(--ink-secondary)] opacity-0 transition-[color,opacity] hover:text-[var(--ink)] focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${align === "right" ? "right-0" : "left-0"}`}>
      {sentAt && <span className="text-xs">{sentAt}</span>}
      <button
        type="button"
        className="grid h-7 w-7 place-items-center rounded-md outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        onClick={copyText}
        aria-label={copied ? "Copied message" : "Copy message"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function ActivityPanel({ segment, open, onToggle }: { segment: ActivitySegment; open: boolean; onToggle: () => void }) {
  const thoughts = segment.entries.flatMap((entry) => entry.kind === "thought" ? [entry.thought] : []);
  const actions = segment.entries.flatMap((entry) => entry.kind === "action" ? [entry.item] : []);
  const runningItem = actions.find((item) => item.state === "running");
  const hasStreamingThought = thoughts.some((thought) => thought.state === "running");
  const header = segment.isLive && runningItem ? runningItem.activeLabel : segment.isLive && hasStreamingThought ? "Thinking" : segment.title;

  return (
    <div className="py-1.5 pr-1 text-xs text-[var(--ink-muted)]">
      <button
        type="button"
        className="group inline-flex max-w-full items-center gap-1.5 rounded-md py-1.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="min-w-0 truncate font-medium group-hover:font-semibold">{header}</span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        {segment.isLive && <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">Working</span>}
      </button>

      <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="ml-[7px] mt-1.5 border-l border-[var(--hairline)] pl-4">
            <div className="space-y-3 pb-0.5">
              {thoughts.map((thought) => <ActivityThoughtBlock key={thought.id} thought={thought} isLive={segment.isLive} panelOpen={open} />)}
              {actions.length > 0 && (
                <div className="space-y-2.5 pt-0.5">
                  {actions.map((item) => <ActivityRow key={item.id} item={item} />)}
                </div>
              )}
              {actions.length > 0 && !segment.isLive && actions.every((item) => item.state !== "running") && (
                <div className="flex items-center gap-2 text-[var(--ink-muted)]">
                  <Check className="h-3.5 w-3.5" />
                  <span>Done</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityThoughtBlock({ thought, isLive, panelOpen }: { thought: ActivityThought; isLive: boolean; panelOpen: boolean }) {
  const isRunning = isLive && thought.state === "running";
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const text = thought.text.trim();
  const isLong = text.length > 360 || text.split("\n").length > 6;

  useEffect(() => {
    if (!panelOpen) setExpanded(false);
  }, [panelOpen, thought.id]);

  useEffect(() => {
    if (!isRunning || expanded) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [expanded, isRunning, text]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[var(--ink-muted)]">
        {isRunning ? <ThinkingDot /> : <Check className="h-3.5 w-3.5" />}
        <span>{isRunning ? "Thinking" : "Thought"}</span>
      </div>
      <div className="ml-5 border-l border-[var(--hairline)] pl-3">
        <div
          ref={scrollRef}
          className={`pr-1 text-[12.5px] leading-5 text-[var(--ink-muted)] ${isRunning ? "scrollbar-hidden max-h-28 overflow-y-auto" : !expanded ? "max-h-28 overflow-hidden" : ""}`}
        >
          <ActivityMarkdown text={text} />
        </div>
        {!isRunning && isLong && (
          <button
            type="button"
            className="mt-1 rounded-md text-[11px] font-medium text-[var(--ink-muted)] outline-none transition-colors hover:text-[var(--ink-secondary)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const isRunning = item.state === "running";
  const isError = item.state === "error";
  const label = isRunning ? item.activeLabel : item.completedLabel;

  return (
    <div className={`flex items-start gap-2 ${isError ? "text-[var(--danger)]" : "text-[var(--ink-muted)]"}`}>
      {isRunning ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : isError ? (
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{label}</span>
          {item.meta && <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">{item.meta}</span>}
        </div>
        {item.detail && <div className="mt-0.5 truncate text-[11px] text-[var(--ink-faint)]">{item.detail}</div>}
      </div>
    </div>
  );
}

function ActivityMarkdown({ text }: { text: string }) {
  return (
    <div className="[overflow-wrap:anywhere] [&_a]:font-medium [&_a]:text-[var(--ink-secondary)] [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-[var(--surface-muted)] [&_code]:px-1 [&_code]:py-0.5 [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1.5 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-[var(--surface-muted)] [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-medium [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, title, children }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="py-1 text-sm leading-6 text-[var(--ink-secondary)] [overflow-wrap:anywhere] [&_a]:font-medium [&_a]:text-[var(--primary)] [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--hairline-strong)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--ink-muted)] [&_code]:rounded [&_code]:bg-[var(--surface-muted)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.92em] [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-1.5 [&_h3]:mt-2.5 [&_h3]:font-semibold [&_hr]:my-3 [&_hr]:border-[var(--hairline)] [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--surface-muted)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--hairline)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--hairline)] [&_th]:bg-[var(--surface-muted)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, title, children }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function AssistantOrbMark() {
  return (
    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[var(--assistant-orb-border)] bg-[var(--assistant-orb-bg)] text-zinc-950 shadow-[var(--assistant-orb-shadow)]" aria-hidden="true">
      <svg role="graphics-symbol" viewBox="0 0 20 20" className="h-[31px] w-[31px]" xmlns="http://www.w3.org/2000/svg">
        <path d="M12.758 9.976a1.178 1.178 0 1 0 .377-2.326 1.178 1.178 0 0 0-.377 2.326M6.547 8.97a1.178 1.178 0 1 0 .377-2.327 1.178 1.178 0 0 0-.377 2.326" fill="#4F4E49" />
        <path d="M10.573 5.554a3.917 3.917 0 0 1 6.743.035.625.625 0 1 1-1.08.63 2.667 2.667 0 0 0-4.591-.023l-5.398 9.015 4.192.68a.625.625 0 0 1-.2 1.233l-5.102-.827a.625.625 0 0 1-.436-.938zM4.36 3.517a3.92 3.92 0 0 1 5.572.356.625.625 0 1 1-.945.818 2.67 2.67 0 0 0-3.795-.243.625.625 0 1 1-.833-.931" fill="#4F4E49" />
      </svg>
    </div>
  );
}

export function AiPanel({ companyId, onClose }: { companyId: Id<"companies">; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<Id<"aiChatSessions"> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionActionsOpen, setSessionActionsOpen] = useState<Id<"aiChatSessions"> | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<Id<"aiChatSessions"> | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [timestampNow, setTimestampNow] = useState(() => Date.now());
  const [activityPanelPreferences, setActivityPanelPreferences] = useState<Record<string, ActivityPanelPreference>>({});
  const [localMessageTimes, setLocalMessageTimes] = useState<Record<string, number>>({});
  const hydratedSession = useRef<Id<"aiChatSessions"> | null>(null);
  const titleRequested = useRef(new Set<string>());
  const localMessageSession = useRef<Id<"aiChatSessions"> | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameCancelled = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottom = useRef(true);

  const getOrCreate = useMutation(api.aiChat.getOrCreateSession);
  const createSession = useMutation(api.aiChat.createSession);
  const setSessionTitle = useMutation(api.aiChat.setSessionTitle);
  const deleteChatSession = useMutation(api.aiChat.deleteSession);
  const sessions = useQuery(api.aiChat.listSessions, { companyId });
  const persisted = useQuery(api.aiChat.listMessages, sessionId ? { companyId, sessionId } : "skip");
  const currentSession = sessions?.find((session) => session._id === sessionId) ?? null;
  const sessionGroups = useMemo(() => {
    const groups: Array<{ key: string; label?: string; sessions: ChatSession[] }> = [
      { key: "today", label: "Today", sessions: [] },
      { key: "yesterday", label: "Yesterday", sessions: [] },
      { key: "thisWeek", label: "This Week", sessions: [] },
      { key: "thisMonth", label: "This Month", sessions: [] },
      { key: "older", sessions: [] },
    ];
    const groupByKey = new Map(groups.map((group) => [group.key, group]));
    for (const session of sessions ?? []) groupByKey.get(sessionDateBucket(session.updatedAt, timestampNow))?.sessions.push(session);
    return groups.filter((group) => group.sessions.length > 0);
  }, [sessions, timestampNow]);

  useEffect(() => {
    if (!renamingSessionId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingSessionId]);

  useEffect(() => {
    if (!menuOpen) return;
    setTimestampNow(Date.now());
    const interval = window.setInterval(() => setTimestampNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && sessionMenuRef.current?.contains(target)) return;
      setMenuOpen(false);
      setSessionActionsOpen(null);
      setRenamingSessionId(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      setSessionActionsOpen(null);
      setRenamingSessionId(null);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    let cancelled = false;
    const stored = readStoredAiSession(companyId);
    getOrCreate({ companyId, sessionId: stored ?? undefined }).then((id) => {
      if (cancelled) return;
      setSessionId(id);
      rememberStoredAiSession(companyId, id);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, getOrCreate]);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/ai/chat", body: { companyId, sessionId } }), [companyId, sessionId]);
  const { messages, setMessages, sendMessage, status } = useChat({
    id: sessionId ? `${companyId}:${sessionId}` : `pending:${companyId}`,
    transport,
  });
  const isSending = status !== "ready" && !String(status).includes("error");
  const lastMessage = messages[messages.length - 1] as any | undefined;

  useEffect(() => {
    if (!persisted || !sessionId || isSending || hydratedSession.current === sessionId) return;
    if (localMessageSession.current === sessionId && messages.length > 0) return;
    setMessages(persisted.map(toUiMessage) as any);
    hydratedSession.current = sessionId;
  }, [persisted, sessionId, setMessages, isSending, messages.length]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    const node = chatScrollRef.current;
    if (!node || !shouldStickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  });

  function updateShouldStickToBottom() {
    const node = chatScrollRef.current;
    if (!node) return;
    shouldStickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
  }

  useEffect(() => {
    const userMessagesWithoutTime = messages.filter((message: any) => message.role === "user" && !formatMessageTime(message.createdAt) && message.id);
    if (!userMessagesWithoutTime.length) return;
    setLocalMessageTimes((current) => {
      let next = current;
      const now = Date.now();
      for (const message of userMessagesWithoutTime) {
        const id = String(message.id);
        if (next[id]) continue;
        if (next === current) next = { ...current };
        next[id] = now;
      }
      return next;
    });
  }, [messages]);

  function userMessageSentAt(message: any) {
    return formatMessageTime(message.createdAt) ?? formatMessageTime(localMessageTimes[String(message.id ?? "")]);
  }

  function activityPanelOpen(segment: ActivitySegment) {
    const preference = activityPanelPreferences[segment.id];
    return preference?.manual ? preference.open : segment.isLive && segment.entries.length > 0;
  }

  function toggleActivityPanel(segment: ActivitySegment) {
    setActivityPanelPreferences((current) => {
      const open = current[segment.id]?.manual ? current[segment.id].open : segment.isLive;
      return { ...current, [segment.id]: { open: !open, manual: true } };
    });
  }

  function rememberSession(id: Id<"aiChatSessions">) {
    setSessionId(id);
    setMessages([]);
    hydratedSession.current = null;
    localMessageSession.current = null;
    setMenuOpen(false);
    setSessionActionsOpen(null);
    setRenamingSessionId(null);
    setActivityPanelPreferences({});
    rememberStoredAiSession(companyId, id);
  }

  function toggleSessionMenu() {
    const nextOpen = !menuOpen;
    setTimestampNow(Date.now());
    setMenuOpen(nextOpen);
    if (!nextOpen) {
      setSessionActionsOpen(null);
      setRenamingSessionId(null);
    }
  }

  function startRenamingSession(session: { _id: Id<"aiChatSessions">; title?: string }) {
    renameCancelled.current = false;
    setSessionActionsOpen(null);
    setRenamingSessionId(session._id);
    setRenameTitle(sessionLabel(session));
  }

  function cancelRenamingSession() {
    renameCancelled.current = true;
    setRenamingSessionId(null);
    setRenameTitle("");
  }

  async function saveRenamedSession(id: Id<"aiChatSessions">) {
    if (renameCancelled.current || renamingSessionId !== id) return;
    const title = renameTitle.trim();
    if (!title) {
      cancelRenamingSession();
      return;
    }
    renameCancelled.current = true;
    setRenamingSessionId(null);
    setRenameTitle("");
    await setSessionTitle({ companyId, sessionId: id, title });
  }

  async function deleteSession(id: Id<"aiChatSessions">) {
    setSessionActionsOpen(null);
    if (renamingSessionId === id) cancelRenamingSession();
    const newSessionId = sessionId === id ? await createSession({ companyId }) : null;
    if (newSessionId) rememberSession(newSessionId);
    await deleteChatSession({ companyId, sessionId: id });
  }

  async function startNewSession() {
    const isCurrentSessionDraft = !!sessionId && messages.length === 0 && (persisted?.length ?? 0) === 0 && !sessions?.some((session) => session._id === sessionId);
    if (isCurrentSessionDraft) {
      setMenuOpen(false);
      return;
    }
    const id = await createSession({ companyId });
    rememberSession(id);
  }

  async function submit(text: string) {
    if (!text.trim() || !sessionId || isSending) return;
    const submittedText = text;
    const shouldTitle = !currentSession?.title && (persisted?.filter((message) => message.role === "user").length ?? 0) === 0 && !titleRequested.current.has(sessionId);
    rememberStoredAiSession(companyId, sessionId);
    setActivityPanelPreferences({});
    localMessageSession.current = sessionId;
    shouldStickToBottom.current = true;
    setInput("");
    try {
      await sendMessage({ text: submittedText });
    } catch {
      setInput((current) => current || submittedText);
      return;
    }
    if (shouldTitle) {
      titleRequested.current.add(sessionId);
      void fetch("/api/ai/title", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId, sessionId, firstMessage: submittedText }) }).catch(() => null);
    }
  }

  return (
    <aside className="fixed bottom-2 right-2 top-2 z-40 flex w-[min(420px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl bg-[var(--chrome-translucent)] text-[var(--ink)] shadow-[var(--shadow-popover)] backdrop-blur-sm md:static md:z-auto md:w-[392px] md:shrink-0 md:rounded-lg md:shadow-none">
      <header className="relative flex h-11 shrink-0 items-center justify-between px-2.5">
        <div ref={sessionMenuRef} className="flex min-w-0 items-center gap-1.5">
          <button type="button" onClick={toggleSessionMenu} className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium hover:bg-[var(--surface-hover)]" aria-label="Switch AI session" aria-expanded={menuOpen}>
            <span className="truncate">{sessionLabel(currentSession)}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
          </button>
          {menuOpen && (
            <div className="absolute left-2 right-2 top-10 z-10 overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-popover)]">
              {sessions === undefined && <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">Loading sessions…</div>}
              {sessions?.length === 0 && <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">No sessions yet.</div>}
              <div className="ai-panel-scrollbar max-h-64 overflow-auto p-1">
                {sessionGroups.map((group) => (
                  <div key={group.key}>
                    {group.label && <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-[var(--ink-muted)]">{group.label}</div>}
                    {group.sessions.map((session) => (
                      <div key={session._id} className="relative">
                        <div className={`group/session relative flex w-full items-start rounded-md text-sm hover:bg-[var(--surface-hover)] ${session._id === sessionId ? "bg-[var(--surface-muted)]" : ""}`}>
                          {renamingSessionId === session._id ? (
                            <div className="min-w-0 flex-1 px-2 py-1.5 pr-1">
                              <input
                                ref={renameInputRef}
                                value={renameTitle}
                                onChange={(event) => setRenameTitle(event.target.value)}
                                onBlur={() => void saveRenamedSession(session._id)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void saveRenamedSession(session._id);
                                  }
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    cancelRenamingSession();
                                  }
                                }}
                                className="h-7 w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-sm font-medium outline-none focus:border-[var(--focus-ring)]"
                                aria-label="Rename session"
                              />
                            </div>
                          ) : (
                            <button type="button" onClick={() => rememberSession(session._id)} className="min-w-0 flex-1 px-2 py-2 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                              <div className="truncate pr-1 font-medium">{sessionLabel(session)}</div>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setSessionActionsOpen((open) => open === session._id ? null : session._id)}
                            className={`mr-1 mt-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--ink-muted)] outline-none transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${sessionActionsOpen === session._id ? "opacity-100" : "opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100"}`}
                            aria-label={`Session actions for ${sessionLabel(session)}`}
                            aria-expanded={sessionActionsOpen === session._id}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </div>
                        {sessionActionsOpen === session._id && (
                          <div className="absolute right-1 top-9 z-20 w-32 rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-1 shadow-[var(--shadow-popover)]">
                            <button type="button" onClick={() => startRenamingSession(session)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                              <Pencil className="h-3.5 w-3.5" />
                              Rename
                            </button>
                            <button type="button" onClick={() => void deleteSession(session._id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--danger)] hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={startNewSession} aria-label="New AI session"><MessageCirclePlus className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close AI panel"><ChevronsRight className="h-5 w-5" /></Button>
        </div>
      </header>

      <div ref={chatScrollRef} onScroll={updateShouldStickToBottom} className="ai-panel-scrollbar min-h-0 flex-1 space-y-3 overflow-auto p-3 pb-10">
        {persisted === undefined && sessionId !== null && messages.length === 0 && (
          <div className="animate-pulse space-y-3 pt-4">
            <div className="h-14 rounded-lg bg-[var(--surface-muted)]" />
            <div className="ml-8 h-16 rounded-lg bg-[var(--surface-muted)]" />
            <div className="h-14 rounded-lg bg-[var(--surface-muted)]" />
          </div>
        )}

        {messages.length === 0 && persisted !== undefined && (
          <div className="flex min-h-full flex-col justify-end px-3 pb-1 pt-10">
            <AssistantOrbMark />
            <h3 className="mt-4 text-base font-semibold">How can I help you today?</h3>
          </div>
        )}

        {messages.map((message: any) => {
          if (message.role === "assistant") {
            const isLiveAssistant = isSending && lastMessage?.id === message.id;
            const blocks = buildAssistantBlocks(message, isLiveAssistant);
            const assistantText = blocks.flatMap((block) => block.kind === "text" ? [block.text.trim()] : []).filter(Boolean).join("\n\n");
            if (isLiveAssistant && blocks.length === 0) return <PendingThinkingIndicator key={message.id} />;
            return (
              <div key={message.id} className="group relative -mb-8 mr-7 px-1 pb-8 pt-1">
                {blocks.map((block) => block.kind === "activity" ? (
                  <ActivityPanel key={block.segment.id} segment={block.segment} open={activityPanelOpen(block.segment)} onToggle={() => toggleActivityPanel(block.segment)} />
                ) : (
                  <AssistantMarkdown key={block.id} text={block.text.trim()} />
                ))}
                {assistantText && <CopyMessageButton text={assistantText} align="left" />}
              </div>
            );
          }

          const text = textOf(message).trim();
          const sentAt = userMessageSentAt(message);
          if (!text) return null;
          return (
            <div key={message.id} className="group relative -mb-8 w-full pb-8">
              <div className="ml-auto w-fit max-w-[82%] rounded-2xl bg-[var(--chat-user-bg)] px-3 py-2 text-[var(--chat-user-fg)]">
                <div className="whitespace-pre-wrap text-sm leading-6 text-[var(--chat-user-fg)]">{text}</div>
              </div>
              <CopyMessageButton text={text} align="right" sentAt={sentAt} />
            </div>
          );
        })}

        {isSending && lastMessage?.role === "user" && <PendingThinkingIndicator />}
      </div>

      <form className="shrink-0 bg-[var(--chrome-translucent)] px-3 pb-1 pt-3" onSubmit={(event) => { event.preventDefault(); void submit(input); }}>
        <div className="cursor-text rounded-2xl bg-[var(--surface)] p-2 ring-1 ring-[var(--hairline)] focus-within:ring-[var(--focus-ring)]" onClick={() => textareaRef.current?.focus()}>
          <Textarea
            ref={textareaRef}
            id="ai-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit(input);
              }
            }}
            placeholder="Do anything with AI..."
            className="max-h-40 min-h-10 resize-none border-0 bg-transparent p-1.5 focus:border-0"
          />
          <div className="mt-1 flex justify-end">
            <Button type="submit" variant="primary" size="icon" disabled={!sessionId || !input.trim() || isSending} aria-label="Send message" className="rounded-full disabled:bg-[var(--surface-muted)] disabled:text-[var(--ink-muted)]"><ArrowUp className="h-4 w-4" /></Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
