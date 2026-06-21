"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMutation, useQuery } from "convex/react";
import { ArrowUp, ChevronDown, ChevronsRight, Loader2, MessageCirclePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { safeActivityLabel } from "@/lib/ai/activity";
import { textOf, toUiMessage } from "@/lib/message-utils";

function messageActivities(messages: any[]) {
  const names: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const type = String(part.type ?? "");
      const name = type.startsWith("tool-") ? type.slice(5) : type === "dynamic-tool" ? String(part.toolName ?? "") : "";
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names.slice(-4).map((name) => ({ name, label: safeActivityLabel(name) }));
}

function sessionLabel(session?: { title?: string } | null) {
  return session?.title?.trim() || "New Session";
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
  const [activityOpen, setActivityOpen] = useState(true);
  const [manualActivityToggle, setManualActivityToggle] = useState(false);
  const hydratedSession = useRef<Id<"aiChatSessions"> | null>(null);
  const titleRequested = useRef(new Set<string>());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const getOrCreate = useMutation(api.aiChat.getOrCreateSession);
  const createSession = useMutation(api.aiChat.createSession);
  const sessions = useQuery(api.aiChat.listSessions, { companyId });
  const persisted = useQuery(api.aiChat.listMessages, sessionId ? { companyId, sessionId } : "skip");
  const currentSession = sessions?.find((session) => session._id === sessionId) ?? null;

  useEffect(() => {
    let cancelled = false;
    const storageKey = `cendro:ai-session:${companyId}`;
    let stored: Id<"aiChatSessions"> | null = null;
    try {
      stored = localStorage.getItem(storageKey) as Id<"aiChatSessions"> | null;
    } catch {
      stored = null;
    }
    getOrCreate({ companyId, sessionId: stored ?? undefined }).then((id) => {
      if (cancelled) return;
      setSessionId(id);
      try {
        localStorage.setItem(storageKey, id);
      } catch {
        // Ignore unavailable localStorage.
      }
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
  const activities = useMemo(() => messageActivities(messages as any[]), [messages]);
  const isSending = status !== "ready" && !String(status).includes("error");
  const assistantStreamingText = isSending && messages.some((message: any) => message.role === "assistant" && textOf(message).trim());

  useEffect(() => {
    if (!persisted || !sessionId || isSending || hydratedSession.current === sessionId) return;
    setMessages(persisted.map(toUiMessage) as any);
    hydratedSession.current = sessionId;
  }, [persisted, sessionId, setMessages, isSending]);

  useEffect(() => {
    if (!activities.length) return;
    if (assistantStreamingText && !manualActivityToggle) setActivityOpen(false);
    else if (isSending && !manualActivityToggle) setActivityOpen(true);
  }, [activities.length, assistantStreamingText, isSending, manualActivityToggle]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [input]);

  function rememberSession(id: Id<"aiChatSessions">) {
    setSessionId(id);
    setMessages([]);
    hydratedSession.current = null;
    setMenuOpen(false);
    setActivityOpen(true);
    setManualActivityToggle(false);
    try {
      localStorage.setItem(`cendro:ai-session:${companyId}`, id);
    } catch {
      // Ignore unavailable localStorage.
    }
  }

  async function startNewSession() {
    const id = await createSession({ companyId });
    rememberSession(id);
  }

  async function submit(text: string) {
    if (!text.trim() || !sessionId || isSending) return;
    const shouldTitle = !currentSession?.title && (persisted?.filter((message) => message.role === "user").length ?? 0) === 0 && !titleRequested.current.has(sessionId);
    setActivityOpen(true);
    setManualActivityToggle(false);
    try {
      await sendMessage({ text });
      setInput((current) => current === text ? "" : current);
    } catch {
      return;
    }
    if (shouldTitle) {
      titleRequested.current.add(sessionId);
      void fetch("/api/ai/title", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId, sessionId, firstMessage: text }) }).catch(() => null);
    }
  }

  return (
    <aside className="fixed bottom-2 right-2 top-2 z-40 flex w-[min(420px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl bg-[var(--chrome-translucent)] text-[var(--ink)] shadow-[var(--shadow-popover)] backdrop-blur-sm md:static md:z-auto md:w-[392px] md:shrink-0 md:rounded-lg md:shadow-none">
      <header className="relative flex h-11 shrink-0 items-center justify-between px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <button onClick={() => setMenuOpen((open) => !open)} className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium hover:bg-[var(--surface-hover)]" aria-label="Switch AI session" aria-expanded={menuOpen}>
            <span className="truncate">{sessionLabel(currentSession)}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={startNewSession} aria-label="New AI session"><MessageCirclePlus className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close AI panel"><ChevronsRight className="h-5 w-5" /></Button>
        </div>
        {menuOpen && (
          <div className="absolute left-2 right-2 top-10 z-10 overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-popover)]">
            <div className="border-b border-[var(--hairline)] px-3 py-2 text-xs font-medium text-[var(--ink-muted)]">Sessions</div>
            {sessions === undefined && <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">Loading sessions…</div>}
            {sessions?.length === 0 && <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">No sessions yet.</div>}
            <div className="max-h-64 overflow-auto p-1">
              {sessions?.map((session) => (
                <button key={session._id} onClick={() => rememberSession(session._id)} className={`block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-[var(--surface-hover)] ${session._id === sessionId ? "bg-[var(--surface-muted)]" : ""}`}>
                  <div className="truncate font-medium">{sessionLabel(session)}</div>
                  <div className="text-xs text-[var(--ink-muted)]">{new Date(session.updatedAt).toLocaleDateString()}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
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

        {activities.length > 0 && isSending && (
          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-2.5 text-xs text-[var(--ink-muted)]">
            <button type="button" className="flex w-full items-center justify-between" onClick={() => { setActivityOpen((open) => !open); setManualActivityToggle(true); }}>
              <span className="font-medium text-[var(--ink-secondary)]">Activity</span>
              <span>{activityOpen ? "Hide" : "Show"}</span>
            </button>
            {activityOpen && <div className="mt-2 space-y-1.5">{activities.map((activity) => <div key={activity.name} className="flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />{activity.label}</div>)}</div>}
          </div>
        )}

        {messages.map((message: any) => {
          const text = textOf(message).trim();
          if (!text) return null;
          return (
            <div key={message.id} className={message.role === "user" ? "ml-7 rounded-xl bg-[var(--surface-muted)] p-3" : "mr-7 rounded-xl bg-[var(--surface)] p-3 ring-1 ring-[var(--hairline)]"}>
              <div className="mb-1 text-xs capitalize text-[var(--ink-muted)]">{message.role === "user" ? "You" : "Cendro AI"}</div>
              <div className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">{text}</div>
            </div>
          );
        })}
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
