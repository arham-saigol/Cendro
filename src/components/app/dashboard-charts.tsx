"use client";

import { useMemo } from "react";
import { barY, defineChart } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/charts/react";

export type DashboardTrendPoint = {
  bucketStart: number;
  label: string;
  jdDue: number;
  jdCompleted: number;
  tasksAssigned: number;
  tasksCompleted: number;
};

export type DashboardTrendMode = "jd" | "tasks";

type ChartRow = { label: string; total: number; completed: number };

export function DashboardTrendChart({
  points,
  mode,
  height = 260,
}: {
  points: DashboardTrendPoint[];
  mode: DashboardTrendMode;
  height?: number;
}) {
  const totalLabel = mode === "jd" ? "Due" : "Assigned";
  const data = useMemo<ChartRow[]>(
    () =>
      points.map((point) => ({
        label: point.label,
        total: mode === "jd" ? point.jdDue : point.tasksAssigned,
        completed: mode === "jd" ? point.jdCompleted : point.tasksCompleted,
      })),
    [points, mode],
  );

  const definition = useMemo(() => {
    if (data.length === 0) return null;
    const maxTotal = Math.max(4, ...data.map((row) => row.total));
    return defineChart({
      marks: [
        barY(data, { x: "label", y: "total", fill: "var(--hairline-strong)", radius: 2 }),
        barY(data, { x: "label", y: "completed", fill: "var(--ink)", radius: 2 }),
      ],
      x: {
        scale: () => scaleBand<string>().domain(data.map((row) => row.label)).padding(0.35),
        axis: {
          line: false,
          ticks: { size: 0, padding: 8 },
          tickLabels: { fontSize: 11, thin: data.length > 12 ? { priority: "ends" } : false },
        },
      },
      y: {
        scale: () => scaleLinear().domain([0, maxTotal]),
        nice: true,
        grid: true,
        axis: {
          line: false,
          ticks: { size: 0, padding: 8, format: (value) => (Number.isInteger(value) ? String(value) : "") },
          tickLabels: { fontSize: 11 },
        },
      },
      theme: {
        foreground: "var(--ink-faint)",
        muted: "var(--ink-faint)",
        grid: "var(--hairline)",
        background: "transparent",
      },
      tooltip: {
        use: tooltip,
        content: (chartPoints) => {
          const row = chartPoints[0]?.datum;
          if (!row) return { rows: [] };
          return {
            title: row.label,
            rows: [
              { label: totalLabel, value: String(row.total) },
              { label: "Completed", value: String(row.completed) },
            ],
          };
        },
      },
    });
  }, [data, totalLabel]);

  if (!definition) return null;

  return (
    <div className="dashboard-chart w-full">
      <Chart
        definition={definition}
        height={height}
        ariaLabel={mode === "jd" ? "Job description work due per period" : "Tasks assigned per period"}
      />
    </div>
  );
}
