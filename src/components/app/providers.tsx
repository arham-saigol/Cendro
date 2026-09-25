"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient, useConvexAuth, useMutation } from "convex/react";
import { useEffect } from "react";
import { api } from "../../../convex/_generated/api";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const convex = url ? new ConvexReactClient(url) : null;

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
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      <UserSync />
      {children}
    </ConvexProviderWithClerk>
  );
}
