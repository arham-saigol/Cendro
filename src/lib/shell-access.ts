/**
 * Shell boot access state: which stage of the sign-in -> Convex auth -> access
 * query chain is still pending, and the policy for escalating a stall into a
 * recoverable error. Kept framework-free so it is unit-testable; the React
 * wiring lives in company-context.tsx and app-shell.tsx.
 */

export type ShellWaitingStatus = "loading" | "convexUnauthenticated" | "profileMissing";

/** The stage of the boot chain that is still pending while status === "loading". */
export type ShellLoadingStage = "session" | "convex-auth" | "data";

export type ShellConnection = {
  isWebSocketConnected: boolean;
  hasEverConnected: boolean;
  connectionRetries: number;
};

/** Skeleton cards escalate to a recoverable error after this long pending. */
export const SHELL_STALL_WARN_MS = 20_000;
/** One automatic reload per this much continuous stall, capped below. */
export const SHELL_AUTO_RETRY_MS = 45_000;
export const SHELL_MAX_AUTO_RETRIES = 2;

const RETRY_STORAGE_KEY = "cendro.shellRetries";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** sessionStorage can throw in private browsing; retry counting degrades gracefully. */
export function shellRetryStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function isShellWaiting(status: string): status is ShellWaitingStatus {
  return status === "loading" || status === "convexUnauthenticated" || status === "profileMissing";
}

export function loadingStage(input: {
  clerkLoaded: boolean;
  clerkSignedIn: boolean;
  convexAuthLoading: boolean;
  convexAuthenticated: boolean;
  accessPending: boolean;
}): ShellLoadingStage | null {
  if (!input.clerkLoaded) return "session";
  if (!input.clerkSignedIn) return null;
  if (!input.convexAuthenticated) return input.convexAuthLoading ? "convex-auth" : null;
  return input.accessPending ? "data" : null;
}

export function shellStageLabel(stage: ShellLoadingStage): string {
  switch (stage) {
    case "session":
      return "sign-in service";
    case "convex-auth":
      return "secure session handshake";
    case "data":
      return "workspace data";
  }
}

export function shouldAutoRetry(elapsedMs: number, autoRetries: number): boolean {
  return elapsedMs >= SHELL_AUTO_RETRY_MS && autoRetries < SHELL_MAX_AUTO_RETRIES;
}

export function readShellRetries(storage: StorageLike | null | undefined): number {
  try {
    return Math.max(0, Number(storage?.getItem(RETRY_STORAGE_KEY)) || 0);
  } catch {
    return 0;
  }
}

export function bumpShellRetries(storage: StorageLike | null | undefined): number {
  const next = readShellRetries(storage) + 1;
  try {
    storage?.setItem(RETRY_STORAGE_KEY, String(next));
  } catch {
    // Storage can be unavailable in private browsing; retries stay uncapped-free.
  }
  return next;
}

export function clearShellRetries(storage: StorageLike | null | undefined): void {
  try {
    storage?.removeItem(RETRY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Whether the retry counter can actually persist (and therefore cap auto-reloads
 * across page reloads). Without it each reload restarts at zero and a stall
 * would reload-loop forever, so the hook disables automatic retries in that
 * case; manual retry stays available.
 */
export function shellRetriesPersistable(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    const current = storage.getItem(RETRY_STORAGE_KEY) ?? "0";
    storage.setItem(RETRY_STORAGE_KEY, current);
    return storage.getItem(RETRY_STORAGE_KEY) === current;
  } catch {
    return false;
  }
}

export type ShellStallSummary = {
  status: string;
  stage: ShellLoadingStage | null;
  elapsedSeconds: number;
  webSocketConnected: boolean;
  everConnected: boolean;
  connectionRetries: number;
  online: boolean;
  autoRetries: number;
};

/** Non-sensitive stall diagnostics, safe for console logs and on-screen display. */
export function shellStallSummary(input: {
  status: string;
  stage: ShellLoadingStage | null;
  elapsedMs: number;
  connection: ShellConnection | null;
  autoRetries: number;
  online: boolean;
}): ShellStallSummary {
  return {
    status: input.status,
    stage: input.stage,
    elapsedSeconds: Math.round(input.elapsedMs / 1000),
    webSocketConnected: input.connection?.isWebSocketConnected ?? false,
    everConnected: input.connection?.hasEverConnected ?? false,
    connectionRetries: input.connection?.connectionRetries ?? 0,
    online: input.online,
    autoRetries: input.autoRetries,
  };
}
