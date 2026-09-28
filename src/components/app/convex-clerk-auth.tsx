"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexProviderWithAuth, useConvexAuth } from "convex/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { boundGetToken } from "@/lib/clerk-token";

const RetryContext = createContext<{ attempt: number; retry: () => void } | null>(null);

// Convex's Clerk adapter only watches orgId/orgRole. It does not reauthenticate
// on a signed-in -> signed-in session switch, and after two failed token fetches
// its auth manager remains unauthenticated until setAuth is called again.
function useClerkAuthForConvex() {
  const { isLoaded, isSignedIn, sessionId, orgId, orgRole, sessionClaims, getToken } = useAuth();
  const retry = useContext(RetryContext);
  if (!retry) throw new Error("Missing Convex auth retry provider");
  const fetchToken = useMemo(() => boundGetToken(getToken), [getToken]);
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

  // The token endpoint can recover without a session or network event. A null
  // token is terminal to Convex's auth manager, so request a new handshake
  // rather than leaving the tab unable to sign in until somebody reloads it.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || isLoading || isAuthenticated) return;
    const timer = setTimeout(retry.retry, Math.min(5_000 * 2 ** Math.min(retry.attempt, 4), 60_000));
    return () => clearTimeout(timer);
  }, [isLoaded, isSignedIn, sessionId, isLoading, isAuthenticated, retry]);
  return null;
}

export function ConvexClerkAuthProvider({ client, children }: {
  client: React.ComponentProps<typeof ConvexProviderWithAuth>["client"];
  children?: React.ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const value = useMemo(() => ({ attempt, retry }), [attempt, retry]);
  return (
    <RetryContext.Provider value={value}>
      <ConvexProviderWithAuth client={client} useAuth={useClerkAuthForConvex}>
        <RetryFailedAuth />
        {children}
      </ConvexProviderWithAuth>
    </RetryContext.Provider>
  );
}
