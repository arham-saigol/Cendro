"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useClerk, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  Check,
  ChevronDown,
  FileText,
  LayoutDashboard,
  LogOut,
  Moon,
  Repeat,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { CompanyProvider, useCompany, type CompanyAccess } from "./company-context";
import { AiPanel } from "./ai-panel";
import { useTheme } from "./theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canAccessCompanyManagement, canViewDashboard } from "@/lib/permissions";
import { cn, initials } from "@/lib/utils";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, requiresDashboard: true },
  { href: "/jd-tasks", label: "JD Tasks", icon: Repeat },
  { href: "/one-time-tasks", label: "One-Time Tasks", icon: Check },
  { href: "/sops", label: "SOPs", icon: FileText },
  { href: "/company", label: "Company Management", icon: Building2, requiresCompanyManagement: true },
];

const dropdownItemClass =
  "flex min-h-9 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--ink-secondary)] outline-none data-[highlighted]:bg-[var(--surface-hover)] data-[highlighted]:text-[var(--ink)]";

function ShellCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--chrome)] p-6">
      <div className="w-full max-w-md rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-6 shadow-[var(--shadow-popover)]">{children}</div>
    </div>
  );
}

function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useUser();
  const { theme, toggleTheme } = useTheme();
  const profile = useQuery(api.users.me);
  const updateName = useMutation(api.users.updateCurrentName);
  const [firstName, setFirstName] = useState("");
  const [secondName, setSecondName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFirstName(profile?.firstName || user?.fullName || "");
      setSecondName(profile?.secondName || "");
      setError(null);
    }
  }, [open, profile?.firstName, profile?.secondName, user?.fullName]);

  async function saveName() {
    const trimmedFirstName = firstName.trim();
    const trimmedSecondName = secondName.trim();
    if (!trimmedFirstName || !user || saving) return;
    setSaving(true);
    setError(null);
    try {
      await user.update({ firstName: trimmedFirstName, lastName: trimmedSecondName || null });
      await updateName({ firstName: trimmedFirstName, secondName: trimmedSecondName });
      await user.reload();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your name.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[var(--shadow-popover)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-base font-semibold">Settings</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-[var(--ink-muted)]">Update the names shown in Cendro.</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close settings">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-[var(--ink-secondary)]" htmlFor="profile-first-name">
                First name
              </label>
              <Input id="profile-first-name" className="mt-2" value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="First name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--ink-secondary)]" htmlFor="profile-second-name">
                Second name
              </label>
              <Input id="profile-second-name" className="mt-2" value={secondName} onChange={(event) => setSecondName(event.target.value)} placeholder="Second name" />
            </div>
          </div>
          {error && <p className="alert-error mt-3 rounded-md p-2 text-sm">{error}</p>}
          <div className="mt-5 border-t border-[var(--hairline)] pt-4">
            <div className="mb-2 text-sm font-medium text-[var(--ink-secondary)]">Appearance</div>
            <Button variant="secondary" onClick={toggleTheme} type="button">
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === "dark" ? "Use light mode" : "Use dark mode"}
            </Button>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveName} disabled={saving || !firstName.trim()}>
              {saving ? "Saving..." : "Save names"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SearchCommandDialog({
  open,
  onOpenChange,
  items,
  companies,
  activeCompanyId,
  setActiveCompanyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: typeof nav;
  companies: CompanyAccess[];
  activeCompanyId: CompanyAccess["company"]["_id"] | null;
  setActiveCompanyId: (id: CompanyAccess["company"]["_id"]) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filteredItems = items.filter((item) => item.label.toLowerCase().includes(normalized));
  const filteredCompanies = companies.filter((company) => company.company.name.toLowerCase().includes(normalized));

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Content className="fixed left-1/2 top-[22vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-popover)]">
          <Dialog.Title className="sr-only">Search Cendro</Dialog.Title>
          <div className="flex h-11 items-center gap-2 px-3">
            <Search className="h-4 w-4 text-[var(--ink-faint)]" />
            <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pages and workspaces..." className="h-9 border-0 bg-transparent px-0 focus:border-0" />
          </div>
          <div className="max-h-[360px] overflow-auto px-2 pb-2">
            {filteredItems.length > 0 && <div className="px-2 py-1 text-xs font-medium text-[var(--ink-faint)]">Pages</div>}
            {filteredItems.map((item) => {
              const Icon = item.icon;
              return (
                <Dialog.Close asChild key={item.href}>
                  <Link href={item.href} className="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
                    <Icon className="h-4 w-4 text-[var(--ink-muted)]" />
                    {item.label}
                  </Link>
                </Dialog.Close>
              );
            })}
            {filteredCompanies.length > 0 && <div className="mt-2 px-2 py-1 text-xs font-medium text-[var(--ink-faint)]">Workspaces</div>}
            {filteredCompanies.map((company) => {
              const isActive = company.company._id === activeCompanyId;
              return (
                <button
                  key={company.company._id}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]"
                  onClick={() => {
                    setActiveCompanyId(company.company._id);
                    onOpenChange(false);
                  }}
                >
                  <span className="grid h-5 w-5 place-items-center rounded bg-[var(--surface-muted)] text-xs text-[var(--ink-muted)]">{company.company.name?.[0]?.toUpperCase() ?? "C"}</span>
                  <span className="min-w-0 flex-1 truncate">{company.company.name}</span>
                  {isActive && <Check className="h-4 w-4 text-[var(--ink)]" />}
                </button>
              );
            })}
            {filteredItems.length === 0 && filteredCompanies.length === 0 && <div className="px-2 py-8 text-center text-sm text-[var(--ink-muted)]">No results found.</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AccountCompanyMenu({ searchItems = nav }: { searchItems?: typeof nav }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { companies, activeCompanyId, setActiveCompanyId } = useCompany();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const displayName = user?.fullName || user?.primaryEmailAddress?.emailAddress || "User";

  return (
    <>
      <div className="flex h-8 items-center gap-1">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[var(--ink)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
              <span className="grid h-5 w-5 place-items-center overflow-hidden rounded-md bg-[var(--surface-pressed)] text-[11px] font-medium text-[var(--ink-secondary)]">
                {user?.imageUrl ? <span aria-hidden="true" className="h-full w-full bg-cover bg-center" style={{ backgroundImage: `url(${user.imageUrl})` }} /> : initials(displayName)}
              </span>
              <span className="min-w-0 truncate text-sm font-medium tracking-[-0.01em]">{displayName}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-[var(--ink-faint)]" />
            </button>
          </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={7} className="z-50 w-76 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-2 shadow-[var(--shadow-popover)]">
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-md bg-[var(--surface-pressed)] text-base font-medium text-[var(--ink-secondary)]">
                {user?.imageUrl ? <span aria-hidden="true" className="h-full w-full bg-cover bg-center" style={{ backgroundImage: `url(${user.imageUrl})` }} /> : initials(displayName)}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[var(--ink)]">{displayName}</div>
                {user?.primaryEmailAddress?.emailAddress && <div className="truncate text-xs text-[var(--ink-faint)]">{user.primaryEmailAddress.emailAddress}</div>}
              </div>
            </div>
            <DropdownMenu.Item className={dropdownItemClass} onSelect={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4" />
              Settings
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--hairline)]" />
            <div className="px-2 py-1 text-xs font-medium text-[var(--ink-faint)]">Workspaces</div>
            {companies.map((company: CompanyAccess) => {
              const isActive = company.company._id === activeCompanyId;
              return (
                <DropdownMenu.Item key={company.company._id} className={dropdownItemClass} onSelect={() => setActiveCompanyId(company.company._id)}>
                  <div className="grid h-6 w-6 place-items-center rounded-md bg-[var(--surface-muted)] text-xs font-medium text-[var(--ink-muted)]">
                    {company.company.name?.[0]?.toUpperCase() ?? "C"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-[var(--ink)]">{company.company.name}</div>
                    <div className="text-xs text-[var(--ink-faint)]">{company.membership.role}</div>
                  </div>
                  {isActive && <Check className="h-4 w-4 text-[var(--ink)]" />}
                </DropdownMenu.Item>
              );
            })}
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--hairline)]" />
            <DropdownMenu.Item className={dropdownItemClass} onSelect={() => void signOut({ redirectUrl: "/sign-in" })}>
              <LogOut className="h-4 w-4" />
              Log out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" aria-label="Open search" onClick={() => setSearchOpen(true)}>
          <Search className="h-3.5 w-3.5" />
        </button>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <SearchCommandDialog open={searchOpen} onOpenChange={setSearchOpen} items={searchItems} companies={companies} activeCompanyId={activeCompanyId} setActiveCompanyId={setActiveCompanyId} />
    </>
  );
}

function AssistantOrb({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-5 right-5 z-30 grid h-11 w-11 place-items-center rounded-full border border-[var(--assistant-orb-border)] bg-[var(--assistant-orb-bg)] text-zinc-950 shadow-[var(--assistant-orb-shadow)] transition hover:-translate-y-0.5 hover:bg-[var(--assistant-orb-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] active:translate-y-0 md:bottom-6 md:right-6"
      aria-label="Open AI assistant"
    >
      <svg aria-hidden="true" role="graphics-symbol" viewBox="0 0 20 20" className="h-[31px] w-[31px]" xmlns="http://www.w3.org/2000/svg">
        <path d="M12.758 9.976a1.178 1.178 0 1 0 .377-2.326 1.178 1.178 0 0 0-.377 2.326M6.547 8.97a1.178 1.178 0 1 0 .377-2.327 1.178 1.178 0 0 0-.377 2.326" fill="#4F4E49" />
        <path d="M10.573 5.554a3.917 3.917 0 0 1 6.743.035.625.625 0 1 1-1.08.63 2.667 2.667 0 0 0-4.591-.023l-5.398 9.015 4.192.68a.625.625 0 0 1-.2 1.233l-5.102-.827a.625.625 0 0 1-.436-.938zM4.36 3.517a3.92 3.92 0 0 1 5.572.356.625.625 0 1 1-.945.818 2.67 2.67 0 0 0-3.795-.243.625.625 0 1 1-.833-.931" fill="#4F4E49" />
      </svg>
    </button>
  );
}

function ShellInner({ children, isPlatformAdmin }: { children: React.ReactNode; isPlatformAdmin: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const { accessStatus, email, activeCompanyId, active } = useCompany();
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    if (accessStatus === "signedOut") router.replace(`/sign-in?redirect_url=${encodeURIComponent(path)}`);
  }, [accessStatus, path, router]);

  const canOpenCompanyManagement = canAccessCompanyManagement(active?.capabilities);
  const canViewActiveDashboard = canViewDashboard(active?.capabilities);
  const visibleNav = useMemo(() => nav.filter((item) => (!item.requiresCompanyManagement || canOpenCompanyManagement) && (!item.requiresDashboard || canViewActiveDashboard)), [canOpenCompanyManagement, canViewActiveDashboard]);

  if (accessStatus === "loading") {
    return (
      <div className="min-h-dvh bg-[var(--chrome)] p-8">
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
      <ShellCard>
        <div className="mb-4">
          <AccountCompanyMenu />
        </div>
        <h1 className="text-xl font-semibold">Finishing sign-in</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">We are setting up your authenticated session. Refresh the page in a moment.</p>
        {email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
      </ShellCard>
    );
  }

  if (accessStatus === "paused") {
    return (
      <ShellCard>
        <div className="mb-4">
          <AccountCompanyMenu />
        </div>
        <h1 className="text-xl font-semibold">Access paused</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">Your access to the app has currently been paused. Please contact your administrator.</p>
        {email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
        {isPlatformAdmin && (
          <Button asChild className="mt-4" variant="primary">
            <Link href="/admin">Open platform admin</Link>
          </Button>
        )}
      </ShellCard>
    );
  }

  if (accessStatus === "noCompanies") {
    return (
      <ShellCard>
        <div className="mb-4">
          <AccountCompanyMenu />
        </div>
        <h1 className="text-xl font-semibold">No company access yet</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">Accept an invitation or ask an admin to add you to a company.</p>
        {email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
        {isPlatformAdmin && (
          <Button asChild className="mt-4" variant="primary">
            <Link href="/admin">Open platform admin</Link>
          </Button>
        )}
      </ShellCard>
    );
  }

  return (
    <div className={cn("flex h-dvh overflow-hidden bg-[var(--chrome)] py-2 pl-1.5 text-[var(--ink)]", aiOpen ? "pr-1.5" : "pr-2.5")}>
      <aside className="hidden w-[246px] shrink-0 flex-col bg-[var(--chrome-translucent)] px-2 pb-2 pt-1 backdrop-blur-sm md:flex">
        <AccountCompanyMenu searchItems={visibleNav} />
        <nav className="mt-4 space-y-0.5">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const activeRow = path === item.href || path.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md px-2 text-sm text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-hover)]",
                  activeRow && "bg-[var(--surface-pressed)] text-[var(--ink)]",
                )}
              >
                <Icon className="h-4 w-4 text-[var(--ink-muted)]" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        {isPlatformAdmin && (
          <Button asChild variant="ghost" className="mt-auto justify-start px-2">
            <Link href="/admin">Platform admin</Link>
          </Button>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 bg-[var(--chrome-translucent)] px-2 pb-2 pt-1 backdrop-blur-sm md:hidden">
          <AccountCompanyMenu searchItems={visibleNav} />
          <nav className="mt-2 flex gap-1 overflow-x-auto pb-1">
            {visibleNav.map((item) => {
              const Icon = item.icon;
              const activeRow = path === item.href || path.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-hover)]",
                    activeRow && "bg-[var(--surface-pressed)] text-[var(--ink)]",
                  )}
                >
                  <Icon className="h-4 w-4 text-[var(--ink-muted)]" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
            {isPlatformAdmin && (
              <Button asChild variant="ghost" size="sm" className="h-8 shrink-0 px-2">
                <Link href="/admin">Platform admin</Link>
              </Button>
            )}
          </nav>
        </header>
        <header className="hidden h-0 shrink-0 bg-[var(--chrome-translucent)] backdrop-blur-sm md:block" />

        <div className="flex min-h-0 flex-1 gap-1 overflow-hidden">
          <section className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-[var(--page-outline)] bg-[var(--canvas)]">
            <div className="h-full overflow-auto">
              {children}
            </div>
          </section>
          {!aiOpen && activeCompanyId && <AssistantOrb onClick={() => setAiOpen(true)} />}
          {aiOpen && activeCompanyId && <AiPanel companyId={activeCompanyId} onClose={() => setAiOpen(false)} />}
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children, isPlatformAdmin }: { children: React.ReactNode; isPlatformAdmin: boolean }) {
  return (
    <CompanyProvider>
      <ShellInner isPlatformAdmin={isPlatformAdmin}>{children}</ShellInner>
    </CompanyProvider>
  );
}
