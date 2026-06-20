"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { PageHeader } from "./page-header";
import { useCompany } from "@/components/app/company-context";
import { Badge } from "@/components/ui/badge";

export function SopDetail({ id }: { id: string }) {
  const { activeCompanyId, active } = useCompany();
  const sop = useQuery(api.sops.get, activeCompanyId ? { companyId: activeCompanyId, sopId: id as any } : "skip") as any;

  if (!sop) {
    return (
      <div className="app-page app-page-narrow animate-pulse">
        <div className="h-8 w-2/3 rounded bg-[var(--surface-muted)]" />
        <div className="mt-4 h-6 w-20 rounded bg-[var(--surface-muted)]" />
        <div className="mt-8 h-48 rounded bg-[var(--surface-muted)]" />
      </div>
    );
  }

  return (
    <article className="app-page app-page-narrow">
      <PageHeader
        eyebrow={active?.company.name ?? "SOP"}
        title={sop.title}
        actions={<Badge>{sop.scopeType}</Badge>}
      />
      <div className="whitespace-pre-wrap border-t border-[var(--hairline)] pt-6 leading-7 text-[var(--ink-secondary)]">{sop.content}</div>
    </article>
  );
}
