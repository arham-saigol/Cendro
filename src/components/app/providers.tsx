"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient, useConvexAuth, useMutation } from "convex/react";
import { useEffect, useMemo } from "react";
import { api } from "../../../convex/_generated/api";
import { boundGetToken } from "@/lib/clerk-token";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const convex = url ? new ConvexReactClient(url) : null;

// Clerk's getToken can hang forever (the underlying request has no timeout);
// Convex awaits it to start the auth handshake, so an unanswered request froze
// the app on the skeleton screen indefinitely. Bounding it lets Convex's own
// retry path resolve to a recoverable error state instead.
function useBoundedClerkAuth() {
  const auth = useAuth();
  const getToken = useMemo(() => boundGetToken(auth.getToken), [auth.getToken]);
  return { ...auth, getToken };
}

const SYNC_MAX_ATTEMPTS = 4;

function UserSync() {
  const { isSignedIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const sync = useMutation(api.users.syncCurrentUser);

  useEffect(() => {
    if (!isSignedIn || !isAuthenticated) return;
    let cancelled = false;
    const run = async () => {
      for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS && !cancelled; attempt++) {
        try {
          await sync({});
          return;
        } catch (err) {
          console.warn(`[cendro] user sync failed (attempt ${attempt}/${SYNC_MAX_ATTEMPTS})`, err);
          if (attempt === SYNC_MAX_ATTEMPTS) {
            console.error("[cendro] user sync did not complete; the app may stay on the profile-sync screen.", err);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isSignedIn, sync]);

  return null;
}

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  if (!convex) return <div className="p-6">Set NEXT_PUBLIC_CONVEX_URL in your environment.</div>;

  return (
    <ConvexProviderWithClerk client={convex} useAuth={useBoundedClerkAuth}>
      <UserSync />
      {children}
    </ConvexProviderWithClerk>
  );
}
