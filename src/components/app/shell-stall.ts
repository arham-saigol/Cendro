"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { authDiagnostic, bootEpisode, clearBootEpisode, reportAuthDiagnostic } from "@/lib/auth-diagnostics";
import {
  SHELL_STALL_WARN_MS,
  bumpShellRetries,
  clearShellRetries,
  isShellWaiting,
  readShellRetries,
  shellRetriesPersistable,
  shellRetryStorage,
  shellStallSummary,
  shouldAutoRetry,
  type ShellConnection,
  type ShellLoadingStage,
} from "@/lib/shell-access";

function browserOnline(): boolean {
  // navigator.onLine is a boolean in browsers but can be undefined elsewhere;
  // only an explicit false means offline.
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * Escalates a pending boot state: after SHELL_STALL_WARN_MS the caller swaps the
 * skeleton for a recoverable error card; after SHELL_AUTO_RETRY_MS the page
 * reloads itself once per episode (the retry counter survives reloads and is
 * capped in sessionStorage so a hard outage can't spin forever — if storage
 * can't persist the counter, automatic reloads are disabled entirely and only
 * the manual Try again remains).
 */
export function useShellStall(accessStatus: string, stage: ShellLoadingStage | null, connection: ShellConnection | null) {
  const waiting = isShellWaiting(accessStatus);
  const { sessionId } = useAuth();
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedRef = useRef(0);

  const diagnostics = useCallback(
    (elapsed: number) =>
      authDiagnostic(shellStallSummary({
        status: accessStatus,
        stage,
        elapsedMs: elapsed,
        connection,
        autoRetries: readShellRetries(shellRetryStorage()),
        online: browserOnline(),
      }), sessionId),
    [accessStatus, stage, connection, sessionId],
  );
  // The stall interval outlives renders, so it reads diagnostics through a ref
  // kept fresh after each commit; stage can advance while status stays "loading".
  const diagnosticsRef = useRef(diagnostics);
  useEffect(() => {
    diagnosticsRef.current = diagnostics;
  }, [diagnostics]);

  const retry = useCallback(() => {
    bumpShellRetries(shellRetryStorage());
    const snapshot = diagnosticsRef.current(elapsedRef.current);
    console.warn("[cendro] app shell retry requested", snapshot);
    reportAuthDiagnostic("retry", snapshot);
    window.location.reload();
  }, []);

  useEffect(() => {
    if (!waiting) {
      const storage = shellRetryStorage();
      // A reload resets the local clock but not this episode's retry budget.
      if (elapsedRef.current >= SHELL_STALL_WARN_MS || readShellRetries(storage) > 0) {
        const snapshot = diagnosticsRef.current(elapsedRef.current);
        if (snapshot.status === "ready" || snapshot.status === "noCompanies") reportAuthDiagnostic("recovered", snapshot);
      }
      clearBootEpisode();
      elapsedRef.current = 0;
      setElapsedMs(0);
      clearShellRetries(storage);
      return;
    }
    bootEpisode();
    const storage = shellRetryStorage();
    const persistable = shellRetriesPersistable(storage);
    const startedAt = Date.now();
    let warned = false;
    let autoRetried = false;
    const interval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      elapsedRef.current = elapsed;
      setElapsedMs(elapsed);
      if (elapsed >= SHELL_STALL_WARN_MS && !warned) {
        warned = true;
        const snapshot = diagnosticsRef.current(elapsed);
        console.warn("[cendro] app shell still waiting", snapshot);
        reportAuthDiagnostic("stall", snapshot);
      }
      if (!autoRetried && persistable && shouldAutoRetry(elapsed, readShellRetries(storage))) {
        autoRetried = true;
        bumpShellRetries(storage);
        const snapshot = diagnosticsRef.current(elapsed);
        console.warn("[cendro] app shell auto-retrying after stall", snapshot);
        reportAuthDiagnostic("retry", snapshot);
        window.location.reload();
      }
    }, 1000);
    return () => clearInterval(interval);
    // One continuous wait is one episode: switching between waiting statuses
    // (e.g. loading -> convexUnauthenticated) must not restart the clock.
  }, [waiting]);

  // Read per render so the count persists across auto-reload remounts.
  return { stalled: waiting && elapsedMs >= SHELL_STALL_WARN_MS, elapsedMs, reloads: readShellRetries(shellRetryStorage()), diagnostic: waiting ? diagnostics(elapsedMs) : null, retry };
}
