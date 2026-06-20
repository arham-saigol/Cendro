"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient, useConvexAuth, useMutation } from "convex/react";
import { useEffect } from "react";
import { api } from "../../../convex/_generated/api";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const convex = url ? new ConvexReactClient(url) : null;

function UserSync() {
  const { isSignedIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const sync = useMutation(api.users.syncCurrentUser);

  useEffect(() => {
    if (isSignedIn && isAuthenticated) void sync({}).catch((err) => console.debug("User sync failed", err));
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
