"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexReactClient, useConvexAuth, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect } from "react";
import { api } from "../../../convex/_generated/api";
import { PwaAgent } from "./pwa-agent";
import { ConvexClerkAuthProvider } from "./convex-clerk-auth";
import { recordProfileSync } from "@/lib/auth-diagnostics";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const convex = url ? new ConvexReactClient(url) : null;

function UserSync() {
  const { isSignedIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const sync = useMutation(api.users.syncCurrentUser);

  useEffect(() => {
    if (!isSignedIn || !isAuthenticated) return;
    let cancelled = false;
    recordProfileSync(null);
    const run = async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          await sync({});
          if (!cancelled) recordProfileSync("synced");
          return;
        } catch (err) {
          if (cancelled) return;
          if (err instanceof ConvexError && err.data === "Authenticated email is required.") {
            recordProfileSync("missing-email");
            console.error("[cendro] user sync requires an email claim; ask an administrator to check this account.");
            return;
          }
          const category = err instanceof ConvexError ? "convex-error" : "other-failure";
          recordProfileSync(category);
          if (attempt === 0 || attempt % 10 === 0) console.warn("[cendro] user sync failed; retrying", { category });
          // A transient failure must not permanently strand an already signed-in
          // user on the profile screen after a fixed number of attempts.
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** Math.min(attempt, 6), 60_000)));
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
    <ConvexClerkAuthProvider client={convex}>
      <UserSync />
      <PwaAgent />
      {children}
    </ConvexClerkAuthProvider>
  );
}
