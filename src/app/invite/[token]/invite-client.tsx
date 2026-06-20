"use client";

import { useUser } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function InviteClient({ token }: { token: string }) {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const preview = useQuery(api.invitations.preview, { token });
  const accept = useMutation(api.invitations.accept);
  const [error, setError] = useState<string | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);

  async function acceptInvite() {
    if (!isAuthenticated) return;
    setError(null);
    setIsAccepting(true);
    try {
      const result = await accept({ token });
      localStorage.setItem("cendro.company", result.companyId);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept invitation.");
      setIsAccepting(false);
    }
  }

  const invitePath = `/invite/${encodeURIComponent(token)}`;
  const authUnavailable = isLoaded && isSignedIn && !convexAuthLoading && !isAuthenticated;
  const canAccept = isLoaded && isSignedIn && isAuthenticated && !convexAuthLoading;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--canvas-soft)] p-6">
      <Card className="w-full max-w-md p-6">
        <div className="text-4xl">✉️</div>
        <h1 className="mt-3 text-2xl font-semibold">Cendro invitation</h1>
        {preview === undefined ? <div className="mt-3 space-y-2 animate-pulse">
          <div className="h-4 w-4/5 rounded bg-[var(--surface-pressed)]" />
          <div className="h-6 w-20 rounded-full bg-[var(--surface-pressed)]" />
        </div> : preview ? (
          <div className="mt-3 space-y-2 text-sm">
            <p>You have been invited to join <strong>{preview.companyName}</strong>.</p>
            <p><Badge>{preview.role}</Badge></p>
          </div>
        ) : <p className="mt-2 text-sm text-[var(--ink-muted)]">This invitation is invalid or expired.</p>}
        {authUnavailable && <p className="mt-3 text-sm text-[#b42318]">Could not authenticate your session with Convex. Please refresh and try again.</p>}
        {error && <p className="mt-3 text-sm text-[#b42318]">{error}</p>}
        {preview && <div className="mt-5">
          {isSignedIn ? <Button variant="primary" onClick={acceptInvite} disabled={!canAccept || isAccepting}>{isAccepting ? "Accepting…" : canAccept ? "Accept invitation" : authUnavailable ? "Authentication unavailable" : "Finishing sign-in…"}</Button> : <div className="flex gap-2"><Button asChild><Link href={`/sign-in?redirect_url=${encodeURIComponent(invitePath)}`}>Sign in</Link></Button><Button asChild variant="primary"><Link href={`/sign-up?redirect_url=${encodeURIComponent(invitePath)}`}>Create account</Link></Button></div>}
        </div>}
      </Card>
    </main>
  );
}
