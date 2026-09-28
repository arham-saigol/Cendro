import type { ShellStallSummary } from "./shell-access";

export type TokenOutcome = {
  result: "obtained" | "empty" | "timeout" | "rejected";
  durationMs: number;
  refresh: boolean;
  attempt: number;
  code?: string;
  status?: number;
  requestId?: string;
};

// Only enumerated provider codes and primitive metadata cross the diagnostic boundary.
// Never serialize an Error, token, URL, claims, or arbitrary provider message.
const safeCodes = new Set(["network_error", "session_expired", "session_invalid", "token_expired", "too_many_requests", "rate_limit_exceeded", "resource_forbidden", "invalid_session", "unexpected_error"]);
export function safeTokenError(error: unknown): Pick<TokenOutcome, "code" | "status" | "requestId"> {
  if (!error || typeof error !== "object") return {};
  const value = error as { errors?: unknown; code?: unknown; status?: unknown; requestId?: unknown };
  const first = Array.isArray(value.errors) ? value.errors[0] : value;
  if (!first || typeof first !== "object") return {};
  const item = first as { code?: unknown; status?: unknown; requestId?: unknown };
  const code = typeof item.code === "string" && safeCodes.has(item.code) ? item.code : undefined;
  const status = Number.isInteger(value.status) && Number(value.status) >= 400 && Number(value.status) <= 599 ? Number(value.status) : undefined;
  const requestId = typeof value.requestId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value.requestId) ? value.requestId : undefined;
  return { ...(code && { code }), ...(status && { status }), ...(requestId && { requestId }) };
}

let tokenAttempt = 0;
let currentTokenRequest = Symbol();
let latestTokenScope: string | null | undefined;
let latestToken: TokenOutcome | null = null;
export function beginTokenAttempt(sessionId?: string | null): symbol {
  currentTokenRequest = Symbol();
  latestToken = null;
  latestTokenScope = sessionId;
  tokenAttempt++;
  return currentTokenRequest;
}
export function recordToken(result: Omit<TokenOutcome, "attempt">, request: symbol) {
  if (request !== currentTokenRequest) return; // Superseded token work must not describe the new session.
  latestToken = { ...result, attempt: tokenAttempt };
  if (result.result === "rejected" || result.result === "timeout") console.warn("[cendro] token acquisition", latestToken);
}
export function tokenOutcome(sessionId?: string | null) {
  return sessionId === latestTokenScope ? latestToken : null;
}

export type ProfileOutcome = "synced" | "missing-email" | "convex-error" | "other-failure";
let latestProfile: ProfileOutcome | null = null;
export function recordProfileSync(outcome: ProfileOutcome | null) { latestProfile = outcome; }

const EPISODE_KEY = "cendro.bootEpisode";
let fallbackId: string | null = null;
export function bootEpisode(): string {
  if (!fallbackId) fallbackId = crypto.randomUUID();
  try {
    const id = sessionStorage.getItem(EPISODE_KEY);
    if (id && /^[a-f0-9-]{36}$/.test(id)) return id;
    sessionStorage.setItem(EPISODE_KEY, fallbackId);
  } catch { /* private browsing */ }
  return fallbackId;
}
export function clearBootEpisode() {
  fallbackId = null;
  latestToken = null;
  latestTokenScope = undefined;
  latestProfile = null;
  currentTokenRequest = Symbol();
  tokenAttempt = 0;
  try { sessionStorage.removeItem(EPISODE_KEY); } catch { /* private browsing */ }
}

export type AuthDiagnostic = ShellStallSummary & {
  episode: string;
  build: string;
  token: TokenOutcome | null;
  profile: ProfileOutcome | null;
  confirmation: "confirmed" | "pending" | "terminal" | "not-applicable";
};
export function authDiagnostic(summary: ShellStallSummary, sessionId?: string | null): AuthDiagnostic {
  return {
    ...summary,
    episode: bootEpisode(),
    build: process.env.NEXT_PUBLIC_APP_BUILD ?? "local",
    token: tokenOutcome(sessionId),
    profile: latestProfile,
    confirmation: summary.status === "convexUnauthenticated" ? "terminal" : summary.stage === "convex-auth" ? "pending" : summary.stage === "data" || summary.status === "ready" || summary.status === "profileMissing" ? "confirmed" : "not-applicable",
  };
}

// Best effort; independent of Convex's WebSocket. At most a few summaries per episode.
export function reportAuthDiagnostic(event: "stall" | "retry" | "recovered", snapshot: AuthDiagnostic) {
  if (typeof window === "undefined") return;
  try {
    void fetch("/api/auth-diagnostics", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ...snapshot }), keepalive: true, credentials: "same-origin",
    }).catch(() => {});
  } catch { /* reporting must never block authentication */ }
}
