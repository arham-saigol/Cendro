"use client";

import { SignInButton, SignUpButton, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function InvitePage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const preview = useQuery(api.invitations.preview, { token: params.token }) as { companyName: string; role: string } | null | undefined;
  const accept = useMutation(api.invitations.accept);
  const [error, setError] = useState<string | null>(null);

  async function acceptInvite() {
    try {
      const result = await accept({ token: params.token });
      localStorage.setItem("cendro.company", result.companyId);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept invitation.");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--canvas-soft)] p-6">
      <Card className="w-full max-w-md p-6">
        <div className="text-4xl">✉️</div>
        <h1 className="mt-3 text-2xl font-semibold">Cendro invitation</h1>
        {preview === undefined ? <p className="mt-2 text-sm text-[var(--ink-muted)]">Loading invitation…</p> : preview ? (
          <div className="mt-3 space-y-2 text-sm">
            <p>You have been invited to join <strong>{preview.companyName}</strong>.</p>
            <p><Badge>{preview.role}</Badge></p>
          </div>
        ) : <p className="mt-2 text-sm text-[var(--ink-muted)]">This invitation is invalid or expired.</p>}
        {error && <p className="mt-3 text-sm text-[#b42318]">{error}</p>}
        {preview && <div className="mt-5">
          {isSignedIn ? <Button variant="primary" onClick={acceptInvite}>Accept invitation</Button> : <div className="flex gap-2"><SignInButton mode="modal"><Button>Sign in</Button></SignInButton><SignUpButton mode="modal"><Button variant="primary">Create account</Button></SignUpButton></div>}
        </div>}
      </Card>
    </main>
  );
}
