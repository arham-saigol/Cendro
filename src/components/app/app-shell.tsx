"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Building2, ChevronDown, FileText, Repeat, SquareCheckBig, Sparkles } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { CompanyProvider, useCompany } from "./company-context";
import { AiPanel } from "./ai-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/jd-tasks", label: "JD tasks", icon: Repeat },
  { href: "/one-time-tasks", label: "One-time tasks", icon: SquareCheckBig },
  { href: "/sops", label: "SOPs", icon: FileText },
  { href: "/company", label: "Company management", icon: Building2, requiresCompanyManagement: true },
];

function ShellInner({ children, isPlatformAdmin }: { children: React.ReactNode; isPlatformAdmin: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const { accessStatus, email, companies, activeCompanyId, setActiveCompanyId, active } = useCompany();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (accessStatus === "signedOut") router.replace(`/sign-in?redirect_url=${encodeURIComponent(path)}`);
  }, [accessStatus, path, router]);
  const canManageCompany = active?.capabilities?.includes("company:manage_permissions") ?? false;
  const visibleNav = nav.filter((item) => !item.requiresCompanyManagement || canManageCompany);

  if (accessStatus === "loading") {
    return (
      <div className="min-h-screen bg-[var(--canvas-soft)] p-8">
        <div className="mx-auto max-w-5xl space-y-3">
          <div className="h-8 w-48 animate-pulse rounded bg-[var(--surface-pressed)]" />
          <div className="h-24 w-full animate-pulse rounded bg-[var(--surface-pressed)]" />
          <div className="h-24 w-full animate-pulse rounded bg-[var(--surface-pressed)]" />
        </div>
      </div>
    );
  }

  if (accessStatus === "signedOut") return null;

  if (accessStatus === "convexUnauthenticated" || accessStatus === "profileMissing") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--canvas-soft)]">
        <div className="max-w-md rounded-lg border bg-[var(--surface)] p-6">
          <div className="mb-4 flex justify-end"><UserButton /></div>
          <h1 className="text-2xl font-semibold">Finishing sign-in…</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">We’re setting up your authenticated session. Refresh the page in a moment.</p>
          {email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
        </div>
      </div>
    );
  }

  if (accessStatus === "noCompanies") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--canvas-soft)]">
        <div className="max-w-md rounded-lg border bg-[var(--surface)] p-6">
          <div className="mb-4 flex justify-end"><UserButton /></div>
          <h1 className="text-2xl font-semibold">No company access yet</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">Accept an invitation or ask an admin to add you to a company.</p>
          {email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
          {isPlatformAdmin && <Button asChild className="mt-4" variant="primary"><Link href="/admin">Open platform admin</Link></Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[var(--canvas-soft)]">
      <aside className="w-[270px] shrink-0 border-r border-[var(--hairline)] bg-[var(--surface-muted)] p-3">
        <div className="relative mb-4">
          <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-[var(--surface-pressed)]">
            <div className="grid h-7 w-7 place-items-center rounded bg-[var(--surface)] text-sm font-semibold">{active?.company.name?.[0] || "C"}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{active?.company.name}</div>
              <div className="text-xs text-[var(--ink-muted)]">{active?.membership.role}</div>
            </div>
            {companies.length > 1 && <ChevronDown className="h-4 w-4" />}
          </button>
          {companies.length > 1 && (
            <div className="mt-1 rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-1">
              {companies.map((c: any) => (
                <button key={c.company._id} onClick={() => setActiveCompanyId(c.company._id)} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--surface-muted)]">
                  {c.company.name}<Badge className="ml-2">{c.membership.role}</Badge>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink-faint)]">Workspace</div>
        <nav className="space-y-1">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const activeRow = path.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--ink-secondary)] hover:bg-[var(--surface-pressed)]", activeRow && "bg-[var(--surface-pressed)] text-[var(--ink)]")}>
                <Icon className="h-4 w-4" />{item.label}
              </Link>
            );
          })}
        </nav>
        <div className="absolute bottom-3 left-3"><UserButton /></div>
      </aside>
      <main className="min-w-0 flex-1">
        <header className="flex h-12 items-center justify-between border-b border-[var(--hairline)] bg-[var(--canvas)] px-5">
          <div className="text-sm text-[var(--ink-muted)]">Synced through Convex realtime</div>
          <Button onClick={() => setOpen(true)} variant="secondary"><Sparkles className="h-4 w-4" />AI panel</Button>
        </header>
        {children}
      </main>
      {open && activeCompanyId && <AiPanel companyId={activeCompanyId} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function AppShell({ children, isPlatformAdmin }: { children: React.ReactNode; isPlatformAdmin: boolean }) {
  return <CompanyProvider><ShellInner isPlatformAdmin={isPlatformAdmin}>{children}</ShellInner></CompanyProvider>;
}
