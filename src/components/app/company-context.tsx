"use client";

import { useAuth } from "@clerk/nextjs";
import { createContext, useContext, useMemo, useState } from "react";
import { useConvexAuth, useConvexConnectionState, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { loadingStage, type ShellConnection, type ShellLoadingStage } from "@/lib/shell-access";

export type CompanyAccess = {
  company: { _id: Id<"companies">; name: string; timeZone?: string };
  membership: { _id: Id<"companyMemberships">; role: string; active: boolean; firstName?: string; secondName?: string };
  displayName?: string;
  capabilities: string[];
};

type AccessStatus = "loading" | "signedOut" | "convexUnauthenticated" | "profileMissing" | "noCompanies" | "ready";

type AccessResult =
  | { status: "signedOut" }
  | { status: "convexUnauthenticated" }
  | { status: "profileMissing"; email: string | null }
  | { status: "noCompanies"; email: string }
  | { status: "ready"; email: string; companies: CompanyAccess[] };

type Ctx = {
  accessStatus: AccessStatus;
  /** Which boot stage is still pending while accessStatus === "loading"; null otherwise. */
  loadingStage: ShellLoadingStage | null;
  /** Convex WebSocket diagnostics for stall reporting; null before client subscription. */
  connection: ShellConnection | null;
  email: string | null;
  companies: CompanyAccess[];
  activeCompanyId: Id<"companies"> | null;
  setActiveCompanyId: (id: Id<"companies">) => void;
  active: CompanyAccess | null;
};

const Context = createContext<Ctx | null>(null);

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const connectionState = useConvexConnectionState();
  const queryResult = useQuery(api.companies.accessStatus, isLoaded && isSignedIn && isAuthenticated ? {} : "skip") as AccessResult | undefined;
  const accessStatus: AccessStatus = !isLoaded || (isSignedIn && convexAuthLoading) ? "loading" : !isSignedIn ? "signedOut" : !isAuthenticated ? "convexUnauthenticated" : queryResult?.status ?? "loading";
  const stage = loadingStage({
    clerkLoaded: isLoaded,
    clerkSignedIn: isSignedIn === true,
    convexAuthLoading,
    convexAuthenticated: isAuthenticated,
    accessPending: queryResult === undefined,
  });
  const connection: ShellConnection = useMemo(
    () => ({
      isWebSocketConnected: connectionState.isWebSocketConnected,
      hasEverConnected: connectionState.hasEverConnected,
      connectionRetries: connectionState.connectionRetries,
    }),
    [connectionState],
  );
  const companies = useMemo(() => (queryResult?.status === "ready" ? queryResult.companies : []), [queryResult]);
  const email = queryResult && "email" in queryResult ? queryResult.email : null;
  const [selectedCompanyId, setSelectedCompanyId] = useState<Id<"companies"> | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("cendro.company") as Id<"companies"> | null;
  });

  const active = companies.find((c) => c.company._id === selectedCompanyId) ?? companies.find((c) => c.membership.active) ?? companies[0] ?? null;
  const activeCompanyId = active?.company._id ?? null;

  const setActiveCompanyId = (id: Id<"companies">) => {
    localStorage.setItem("cendro.company", id);
    setSelectedCompanyId(id);
  };

  const value = useMemo(
    () => ({ accessStatus, loadingStage: stage, connection, email, companies, activeCompanyId, setActiveCompanyId, active }),
    [accessStatus, stage, connection, email, companies, activeCompanyId, active],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCompany() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useCompany must be used inside CompanyProvider");
  return ctx;
}
