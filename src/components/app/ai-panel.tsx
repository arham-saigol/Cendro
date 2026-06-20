"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMutation, useQuery } from "convex/react";
import { Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { textOf, toUiMessage } from "@/lib/message-utils";

export function AiPanel({ companyId, onClose }: { companyId: Id<"companies">; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<Id<"aiChatSessions"> | null>(null);
  const getOrCreate = useMutation(api.aiChat.getOrCreateSession);

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
      if (!cancelled) {
        setSessionId(id);
        try {
          localStorage.setItem(storageKey, id);
        } catch {
          // Ignore unavailable localStorage.
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, getOrCreate]);

  const persisted = useQuery(api.aiChat.listMessages, sessionId ? { companyId, sessionId } : "skip");
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/ai/chat", body: { companyId, sessionId } }), [companyId, sessionId]);
  const { messages, setMessages, sendMessage, status } = useChat({ transport });
  const hydratedSession = useRef<Id<"aiChatSessions"> | null>(null);

  useEffect(() => {
    if (!persisted || !sessionId || status !== "ready" || hydratedSession.current === sessionId) return;
    setMessages(persisted.map(toUiMessage) as any);
    hydratedSession.current = sessionId;
  }, [persisted, sessionId, setMessages, status]);

  return (
    <aside className="fixed bottom-2 right-2 top-2 z-40 flex w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden rounded-md bg-[var(--chrome-translucent)] text-[var(--ink)] shadow-[var(--shadow-popover)] backdrop-blur-sm md:static md:z-auto md:w-[384px] md:shrink-0 md:rounded-md md:shadow-none">
      <header className="flex h-10 shrink-0 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Sparkles className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
          <span>AI assistant</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close AI panel">
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {persisted === undefined && sessionId !== null && (
          <div className="animate-pulse space-y-3 pt-4">
            <div className="h-14 rounded-md bg-[var(--surface-muted)]" />
            <div className="ml-8 h-16 rounded-md bg-[var(--surface-muted)]" />
            <div className="h-14 rounded-md bg-[var(--surface-muted)]" />
          </div>
        )}

        {messages.length === 0 && persisted !== undefined && (
          <div className="flex min-h-full flex-col justify-center px-3 py-10">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-muted)]">
              <Sparkles className="h-4 w-4" />
            </div>
            <h3 className="text-base font-semibold">How can I help?</h3>
            <p className="mt-1 max-w-[32ch] text-sm leading-5 text-[var(--ink-muted)]">Ask about tasks, SOPs, analytics, or anything in this workspace.</p>
            <div className="mt-5 grid gap-1.5 text-sm">
              <button onClick={() => setInput("Summarize overdue work")} className="rounded-md px-2.5 py-2 text-left text-[var(--ink-secondary)] hover:bg-[var(--surface-muted)]">
                Summarize overdue work
              </button>
              <button onClick={() => setInput("Search SOPs for closing procedure")} className="rounded-md px-2.5 py-2 text-left text-[var(--ink-secondary)] hover:bg-[var(--surface-muted)]">
                Search SOPs for closing procedure
              </button>
            </div>
          </div>
        )}

        {messages.map((message: any) => (
          <div key={message.id} className={message.role === "user" ? "ml-7 rounded-md bg-[var(--surface-muted)] p-3" : "mr-7 rounded-md bg-[var(--chrome-translucent)] p-3"}>
            <div className="mb-1 text-xs capitalize text-[var(--ink-muted)]">{message.role}</div>
            <div className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">{textOf(message)}</div>
          </div>
        ))}
      </div>

      <form
        className="shrink-0 bg-[var(--chrome-translucent)] p-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!input.trim() || !sessionId) return;
          const text = input;
          setInput("");
          await sendMessage({ text });
        }}
      >
        <div className="rounded-lg bg-[var(--surface)] p-2.5 ring-0">
          <label className="mb-1 block text-xs text-[var(--ink-muted)]" htmlFor="ai-input">Ask Cendro AI</label>
          <Textarea id="ai-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about tasks, SOPs, analytics, or create work..." className="min-h-20 border-0 p-0 focus:border-0" />
          <div className="mt-2 flex justify-end">
            <Button variant="primary" disabled={!sessionId || (status !== "ready" && !String(status).includes("error"))}>
              <Send className="h-4 w-4" />
              Send
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
