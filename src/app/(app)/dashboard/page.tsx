"use client";

import { useQuery } from "convex/react";
import { Activity } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { PageHeader } from "@/components/app/page-header";
import { useCompany } from "@/components/app/company-context";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { canViewDashboard } from "@/lib/permissions";

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card className="px-3 py-3">
      <div className="text-xs text-[var(--ink-muted)]">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[var(--ink)]">{value}</div>
    </Card>
  );
}

export default function Dashboard() {
  const { activeCompanyId, active } = useCompany();
  const canViewActiveDashboard = canViewDashboard(active?.capabilities);
  const data = useQuery(api.analytics.summary, activeCompanyId && canViewActiveDashboard ? { companyId: activeCompanyId } : "skip");

  if (!canViewActiveDashboard) {
    return (
      <div className="app-page">
        <PageHeader title="Dashboard" description="Dashboard access is disabled for your user." />
        <Card className="p-5 text-sm text-[var(--ink-muted)]">Ask an admin to enable dashboard analytics if you need access.</Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app-page animate-pulse space-y-4">
        <div className="h-8 w-48 rounded bg-[var(--surface-muted)]" />
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-20 rounded-md bg-[var(--surface-muted)]" />)}
        </div>
      </div>
    );
  }

  const cards = [
    ["Role", data.role],
    ["People in scope", data.scopeSize],
    ["JD tasks", data.jdTaskCount],
    ["One-time tasks", data.oneTimeTaskCount],
    ["Overdue", data.overdueTasks],
    ["Completion rate", `${data.completionRate}%`],
    ["Visible SOPs", data.sopCount],
  ];

  return (
    <div className="app-page">
      <PageHeader
        title="Dashboard"
        description="Role-aware analytics for your current company."
      />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {cards.map(([label, value]) => <StatCard key={label} label={String(label)} value={value} />)}
      </div>

      <section className="mt-7">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
          <Activity className="h-4 w-4 text-[var(--ink-muted)]" />
          Recent activity
        </div>
        <Card className="overflow-hidden">
          {data.recent.length === 0 ? (
            <div className="p-5 text-sm text-[var(--ink-muted)]">No recent activity yet.</div>
          ) : (
            <div className="divide-y divide-[var(--hairline)]">
              {data.recent.map((event: any) => (
                <div key={event._id} className="grid gap-2 px-3 py-2.5 text-sm md:grid-cols-[160px_1fr_190px] md:items-center">
                  <Badge className="w-fit">{event.action}</Badge>
                  <div className="text-[var(--ink-secondary)]">{event.targetType}</div>
                  <div className="text-xs text-[var(--ink-muted)] md:text-right">{new Date(event.createdAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
