"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SHELL_STALL_WARN_MS,
  bumpShellRetries,
  clearShellRetries,
  isShellWaiting,
  readShellRetries,
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
 * capped in sessionStorage so a hard outage can't spin forever).
 */
export function useShellStall(accessStatus: string, stage: ShellLoadingStage | null, connection: ShellConnection | null) {
  const waiting = isShellWaiting(accessStatus);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [reloads, setReloads] = useState(0);
  const elapsedRef = useRef(0);

  const diagnostics = useCallback(
    (elapsed: number) =>
      shellStallSummary({
        status: accessStatus,
        stage,
        elapsedMs: elapsed,
        connection,
        autoRetries: readShellRetries(shellRetryStorage()),
        online: browserOnline(),
      }),
    [accessStatus, stage, connection],
  );

  const retry = useCallback(() => {
    bumpShellRetries(shellRetryStorage());
    console.warn("[cendro] app shell retry requested", diagnostics(elapsedRef.current));
    window.location.reload();
  }, [diagnostics]);

  useEffect(() => {
    if (!waiting) {
      elapsedRef.current = 0;
      setElapsedMs(0);
      clearShellRetries(shellRetryStorage());
      setReloads(0);
      return;
    }
    const startedAt = Date.now();
    let warned = false;
    let autoRetried = false;
    const interval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      elapsedRef.current = elapsed;
      setElapsedMs(elapsed);
      if (elapsed >= SHELL_STALL_WARN_MS && !warned) {
        warned = true;
        console.warn("[cendro] app shell still waiting", diagnostics(elapsed));
      }
      const retries = readShellRetries(shellRetryStorage());
      if (!autoRetried && shouldAutoRetry(elapsed, retries)) {
        autoRetried = true;
        setReloads(retries + 1);
        bumpShellRetries(shellRetryStorage());
        console.warn("[cendro] app shell auto-retrying after stall", diagnostics(elapsed));
        window.location.reload();
      }
    }, 1000);
    return () => clearInterval(interval);
    // diagnostics intentionally excluded: it reads per-tick elapsed state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, accessStatus]);

  return { stalled: waiting && elapsedMs >= SHELL_STALL_WARN_MS, elapsedMs, reloads, retry };
}
