import { z } from "zod";

export const TRANSPORT_EVENT_LIMIT = 12;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const transportDiagnosticSchema = z.strictObject({
  startedAt: count,
  endpoint: z.string().max(100).regex(/^[a-z0-9-]+\.convex\.cloud$/).nullable(),
  sdk: z.string().max(30).regex(/^\d+\.\d+\.\d+$/).nullable(),
  attempts: count, opens: count, messages: count, authSends: count, authErrors: count,
  events: z.array(z.strictObject({
    atMs: count,
    kind: z.enum(["connecting", "open", "error", "close", "client-close", "constructor-error", "send-error", "csp-blocked", "first-message", "authenticate", "clear-auth", "auth-error", "auth-confirmed", "token-start", "token-obtained", "token-empty", "token-timeout", "token-rejected"]),
    socket: count.optional(),
    code: z.number().int().min(0).max(4999).optional(),
    clean: z.boolean().optional(),
    version: count.optional(),
    authUpdateAttempted: z.boolean().optional(),
    refresh: z.boolean().optional(),
  })).max(TRANSPORT_EVENT_LIMIT),
});
export const savedTransportSchema = z.strictObject({
  episode: z.uuid(),
  build: z.string().max(64).regex(/^[a-zA-Z0-9._-]+$/),
  capturedAt: count,
  transport: transportDiagnosticSchema,
});
export type TransportDiagnostic = z.infer<typeof transportDiagnosticSchema>;
export type SavedTransport = z.infer<typeof savedTransportSchema>;
type TransportEvent = Omit<TransportDiagnostic["events"][number], "atMs">;
let trace: TransportDiagnostic | null = null;

function currentTrace(): TransportDiagnostic {
  return trace ??= { startedAt: Date.now(), endpoint: null, sdk: null, attempts: 0, opens: 0, messages: 0, authSends: 0, authErrors: 0, events: [] };
}
export function recordTransportEvent(event: TransportEvent) {
  const current = currentTrace();
  current.events.push({ ...event, atMs: Math.max(0, Date.now() - current.startedAt) });
  if (current.events.length > TRANSPORT_EVENT_LIMIT) current.events.shift();
}
export function transportDiagnostic(): TransportDiagnostic | null {
  return trace ? { ...trace, events: trace.events.map((event) => ({ ...event })) } : null;
}
export function clearTransportDiagnostic() { trace = null; }

/** Observe only this client's native socket, using Convex's public constructor option.
 * No global patch, extra connection, retry, or change to SDK handlers. Browser error
 * events do not expose HTTP upgrade status or DNS/TLS errors; code 1006 is ambiguous.
 * Never retain payloads, URLs with paths/queries, close reasons, or error messages.
 */
export function diagnosticWebSocket(Base: typeof WebSocket): typeof WebSocket {
  return class extends Base {
    private readonly diagnosticSocket: number;

    constructor(url: string | URL, protocols?: string | string[]) {
      const current = currentTrace();
      const socket = ++current.attempts;
      // Only the public Convex deployment hostname and numeric SDK version.
      const target = new URL(url);
      current.endpoint = /^[a-z0-9-]+\.convex\.cloud$/.test(target.hostname) ? target.hostname : null;
      current.sdk = target.pathname.match(/^\/api\/(\d+\.\d+\.\d+)\/sync$/)?.[1] ?? null;
      recordTransportEvent({ kind: "connecting", socket });
      try { super(url, protocols); } catch (error) {
        recordTransportEvent({ kind: "constructor-error", socket });
        throw error;
      }
      this.diagnosticSocket = socket;
      let received = false;
      let opened = false;
      let observingPolicy = typeof document !== "undefined";
      let policyCleanup: ReturnType<typeof setTimeout> | undefined;
      const stopPolicyObservation = () => {
        if (policyCleanup) clearTimeout(policyCleanup);
        if (observingPolicy) document.removeEventListener("securitypolicyviolation", onPolicyViolation);
        observingPolicy = false;
      };
      this.addEventListener("open", () => {
        opened = true;
        stopPolicyObservation();
        current.opens++;
        recordTransportEvent({ kind: "open", socket });
      });
      this.addEventListener("error", () => recordTransportEvent({ kind: "error", socket }));
      this.addEventListener("close", (event) => {
        recordTransportEvent({ kind: "close", socket, code: event.code, clean: event.wasClean });
        // The document's CSP violation can arrive after the socket close event.
        // Keep observing briefly for failed upgrades, but never retain a listener indefinitely.
        if (!opened && observingPolicy) policyCleanup = setTimeout(stopPolicyObservation, 5_000);
      });
      this.addEventListener("message", (event) => {
        current.messages++;
        if (!received) {
          received = true;
          recordTransportEvent({ kind: "first-message", socket });
        }
        // Inspect only small auth-control frames, not workspace data or chunks.
        if (typeof event.data !== "string" || event.data.length > 8192 || !/"type"\s*:\s*"AuthError"/.test(event.data)) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type !== "AuthError") return;
          current.authErrors++;
          recordTransportEvent({ kind: "auth-error", socket,
            ...(Number.isSafeInteger(message.baseVersion) && message.baseVersion >= 0 && { version: message.baseVersion }),
            ...(typeof message.authUpdateAttempted === "boolean" && { authUpdateAttempted: message.authUpdateAttempted }),
          });
        } catch { /* Diagnostics must not affect the SDK's protocol handling. */ }
      });
      const onPolicyViolation = (event: SecurityPolicyViolationEvent) => {
        // report-only policies do not actually block the connection.
        if (event.disposition !== "enforce" || event.effectiveDirective !== "connect-src") return;
        try {
          const blocked = new URL(event.blockedURI);
          if (blocked.protocol === target.protocol && blocked.host === target.host) {
            recordTransportEvent({ kind: "csp-blocked", socket });
            stopPolicyObservation();
          }
        } catch { /* Browser may redact blockedURI. */ }
      };
      if (observingPolicy) document.addEventListener("securitypolicyviolation", onPolicyViolation);
    }

    override send(data: Parameters<WebSocket["send"]>[0]) {
      try { super.send(data); } catch (error) {
        recordTransportEvent({ kind: "send-error", socket: this.diagnosticSocket });
        throw error;
      }
      if (typeof data !== "string" || data.length > 32768 || !/"type"\s*:\s*"Authenticate"/.test(data)) return;
      try {
        const message = JSON.parse(data);
        if (message.type !== "Authenticate" || (message.tokenType !== "User" && message.tokenType !== "None")) return;
        if (message.tokenType === "User") currentTrace().authSends++;
        recordTransportEvent({ kind: message.tokenType === "User" ? "authenticate" : "clear-auth", socket: this.diagnosticSocket,
          ...(Number.isSafeInteger(message.baseVersion) && message.baseVersion >= 0 && { version: message.baseVersion }),
        });
      } catch { /* Never retain the token or affect sending. */ }
    }

    override close(code?: number, reason?: string) {
      recordTransportEvent({ kind: "client-close", socket: this.diagnosticSocket });
      super.close(code, reason);
    }
  };
}
