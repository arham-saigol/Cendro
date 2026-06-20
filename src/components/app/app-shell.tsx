"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useClerk, useUser } from "@clerk/nextjs";
import { useMutation } from "convex/react";
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
  Sparkles,
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
import { cn, initials } from "@/lib/utils";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/jd-tasks", label: "JD tasks", icon: Repeat },
  { href: "/one-time-tasks", label: "One-time tasks", icon: Check },
  { href: "/sops", label: "SOPs", icon: FileText },
  { href: "/company", label: "Company management", icon: Building2, requiresCompanyManagement: true },
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
  const updateName = useMutation(api.users.updateCurrentName);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(user?.fullName || "");
      setError(null);
    }
  }, [open, user?.fullName]);

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed || !user || saving) return;
    const [firstName, ...rest] = trimmed.split(/\s+/);
    setSaving(true);
    setError(null);
    try {
      await user.update({ firstName, lastName: rest.join(" ") || null });
      await updateName({ name: trimmed });
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
              <Dialog.Description className="mt-1 text-sm text-[var(--ink-muted)]">Update the name shown in Cendro.</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close settings">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>
          <label className="mt-5 block text-sm font-medium text-[var(--ink-secondary)]" htmlFor="profile-name">
            Name
          </label>
          <Input id="profile-name" className="mt-2" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
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
            <Button variant="primary" onClick={saveName} disabled={saving || !name.trim()}>
              {saving ? "Saving..." : "Save name"}
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

function ShellInner({ children, isPlatformAdmin }: { children: React.ReactNode; isPlatformAdmin: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const { accessStatus, email, activeCompanyId, active } = useCompany();
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    if (accessStatus === "signedOut") router.replace(`/sign-in?redirect_url=${encodeURIComponent(path)}`);
  }, [accessStatus, path, router]);

  const canManageCompany = active?.capabilities?.includes("company:manage_permissions") ?? false;
  const visibleNav = useMemo(() => nav.filter((item) => !item.requiresCompanyManagement || canManageCompany), [canManageCompany]);

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
            <Button onClick={() => setAiOpen((open) => !open)} variant={aiOpen ? "secondary" : "ghost"} size="sm" className="absolute left-3 top-2 z-20 h-7 px-2" aria-label="Toggle AI panel" aria-pressed={aiOpen}>
              <Sparkles className="h-3.5 w-3.5" />
              AI
            </Button>
            <div className="h-full overflow-auto">
              {children}
            </div>
          </section>
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
