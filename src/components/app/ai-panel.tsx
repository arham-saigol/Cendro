"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMutation, useQuery } from "convex/react";
import { X, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

function textOf(m: any) { return m.parts?.map((p: any) => p.type === "text" ? p.text : p.type?.startsWith("tool-") ? `[Tool: ${p.type.replace("tool-", "")}]` : "").join("") || m.content || ""; }
function toUiMessage(row: any) { return { id: row._id, role: row.role, parts: [{ type: "text", text: row.content }] }; }

export function AiPanel({ companyId, onClose }: { companyId: Id<"companies">; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<Id<"aiChatSessions"> | null>(null);
  const getOrCreate = useMutation(api.aiChat.getOrCreateSession);
  useEffect(() => { let cancelled = false; getOrCreate({ companyId }).then((id) => { if (!cancelled) setSessionId(id); }); return () => { cancelled = true; }; }, [companyId, getOrCreate]);
  const persisted = useQuery(api.aiChat.listMessages, sessionId ? { companyId, sessionId } : "skip");
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/ai/chat", body: { companyId, sessionId } }), [companyId, sessionId]);
  const { messages, setMessages, sendMessage, status } = useChat({ transport });
  const hydratedSession = useRef<Id<"aiChatSessions"> | null>(null);
  useEffect(() => {
    if (!persisted || !sessionId || status !== "ready" || hydratedSession.current === sessionId) return;
    setMessages(persisted.map(toUiMessage) as any);
    hydratedSession.current = sessionId;
  }, [persisted, sessionId, setMessages, status]);
  return <aside className="flex w-[430px] shrink-0 flex-col border-l border-[var(--hairline)] bg-[var(--canvas)]"><header className="flex h-12 items-center justify-between border-b border-[var(--hairline)] px-4"><div className="flex items-center gap-2 font-medium"><Sparkles className="h-4 w-4" />AI assistant</div><Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button></header><div className="flex-1 space-y-3 overflow-auto p-4">{messages.length === 0 && <div className="mt-24 text-center"><div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-muted)]"><Sparkles className="h-5 w-5" /></div><h3 className="font-semibold">Ask about this workspace</h3><p className="mt-1 text-sm text-[var(--ink-muted)]">I can use tasks, analytics, and SOPs you have access to.</p><div className="mt-4 grid gap-2 text-sm"><button onClick={() => setInput("Summarize overdue work")} className="rounded-md border p-2 text-left hover:bg-[var(--surface-muted)]">Summarize overdue work</button><button onClick={() => setInput("Search SOPs for closing procedure")} className="rounded-md border p-2 text-left hover:bg-[var(--surface-muted)]">Search SOPs</button></div></div>}{messages.map((m: any) => <div key={m.id} className={m.role === "user" ? "ml-8 rounded-lg bg-[var(--surface-muted)] p-3" : "mr-8 rounded-lg border border-[var(--hairline)] p-3"}><div className="mb-1 text-xs text-[var(--ink-muted)]">{m.role}</div><div className="whitespace-pre-wrap text-sm leading-6">{textOf(m)}</div></div>)}</div><form className="border-t border-[var(--hairline)] p-3" onSubmit={async e => { e.preventDefault(); if (!input.trim() || !sessionId) return; const text = input; setInput(""); await sendMessage({ text }); }}><div className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-2 focus-within:border-[var(--focus-ring)]"><div className="mb-1 text-xs text-[var(--ink-muted)]">Current company context</div><Textarea value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about tasks, SOPs, analytics, or create work..." className="min-h-20 border-0 p-0 focus:border-0" /><div className="mt-2 flex justify-end"><Button variant="primary" disabled={!sessionId || (status !== "ready" && !status.includes("error"))}><Send className="h-4 w-4" />Send</Button></div></div></form></aside>;
}
