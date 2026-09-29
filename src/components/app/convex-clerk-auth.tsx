"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexProviderWithAuth, useConvexAuth } from "convex/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { boundGetToken } from "@/lib/clerk-token";
import { recordTransportEvent } from "@/lib/convex-transport-diagnostics";

const RetryContext = createContext<{ attempt: number; failures: number; retry: () => void; recovered: () => void } | null>(null);

// Convex's Clerk adapter only watches orgId/orgRole. It does not reauthenticate
// on a signed-in -> signed-in session switch, and after two failed token fetches
// its auth manager remains unauthenticated until setAuth is called again.
function useClerkAuthForConvex() {
  const { isLoaded, isSignedIn, sessionId, orgId, orgRole, sessionClaims, getToken } = useAuth();
  const retry = useContext(RetryContext);
  if (!retry) throw new Error("Missing Convex auth retry provider");
  const fetchToken = useMemo(() => boundGetToken(getToken, undefined, sessionId), [getToken, sessionId]);
  const fetchAccessToken = useCallback(
    ({ forceRefreshToken }: { forceRefreshToken: boolean }) =>
      fetchToken(sessionClaims?.aud === "convex"
        ? { skipCache: forceRefreshToken }
        : { template: "convex", skipCache: forceRefreshToken }),
    // Convex re-runs setAuth when this callback changes. The principal and
    // retry generation must invalidate it even though they aren't token args.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchToken, sessionId, orgId, orgRole, sessionClaims?.aud, retry.attempt],
  );
  return useMemo(
    () => ({ isLoading: !isLoaded, isAuthenticated: isSignedIn ?? false, fetchAccessToken }),
    [isLoaded, isSignedIn, fetchAccessToken],
  );
}

function RetryFailedAuth() {
  const { isLoaded, isSignedIn, sessionId } = useAuth();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const retry = useContext(RetryContext)!;

  useEffect(() => {
    if (isAuthenticated) recordTransportEvent({ kind: "auth-confirmed" });
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) retry.recovered();
  }, [isAuthenticated, retry]);

  // The token endpoint can recover without a session or network event. A null
  // token is terminal to Convex's auth manager, so request a new handshake
  // rather than leaving the tab unable to sign in until somebody reloads it.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || isLoading || isAuthenticated) return;
    const timer = setTimeout(retry.retry, Math.min(5_000 * 2 ** Math.min(retry.failures, 4), 60_000));
    return () => clearTimeout(timer);
  }, [isLoaded, isSignedIn, sessionId, isLoading, isAuthenticated, retry]);
  return null;
}

export function ConvexClerkAuthProvider({ client, children }: {
  client: React.ComponentProps<typeof ConvexProviderWithAuth>["client"];
  children?: React.ReactNode;
}) {
  const { sessionId } = useAuth();
  const [retryState, setRetryState] = useState<{ sessionId: typeof sessionId; attempt: number; failures: number }>({ sessionId, attempt: 0, failures: 0 });
  const sameSession = retryState.sessionId === sessionId;
  const attempt = sameSession ? retryState.attempt : 0;
  const failures = sameSession ? retryState.failures : 0;
  const retry = useCallback(() => setRetryState((state) => ({
    sessionId,
    attempt: (state.sessionId === sessionId ? state.attempt : 0) + 1,
    failures: (state.sessionId === sessionId ? state.failures : 0) + 1,
  })), [sessionId]);
  const recovered = useCallback(() => setRetryState((state) =>
    state.sessionId === sessionId && state.failures > 0 ? { ...state, failures: 0 } : state,
  ), [sessionId]);
  const value = useMemo(() => ({ attempt, failures, retry, recovered }), [attempt, failures, retry, recovered]);
  return (
    <RetryContext.Provider value={value}>
      <ConvexProviderWithAuth client={client} useAuth={useClerkAuthForConvex}>
        <RetryFailedAuth />
        {children}
      </ConvexProviderWithAuth>
    </RetryContext.Provider>
  );
}
