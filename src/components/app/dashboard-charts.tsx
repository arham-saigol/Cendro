"use client";

import { useMemo } from "react";
import { areaY, defineChart, d3Curve, lineY } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/charts/react";
import { curveMonotoneX } from "d3-shape";

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
    const curve = d3Curve(curveMonotoneX);
    const tickCount = Math.min(6, data.length);
    const tickStep = (data.length - 1) / (tickCount - 1);
    const tickValues = tickCount === 1
      ? [data[0].label]
      : Array.from({ length: tickCount }, (_, index) => data[Math.round(index * tickStep)].label);
    return defineChart({
      marks: [
        areaY(data, { x: "label", y: "total", fill: "url(#dash-total-fill)", curve }),
        areaY(data, { x: "label", y: "completed", fill: "url(#dash-completed-fill)", curve }),
        lineY(data, { x: "label", y: "total", stroke: "var(--ink-secondary)", strokeWidth: 1.5, curve }),
        lineY(data, { x: "label", y: "completed", stroke: "var(--badge-blue-fg)", strokeWidth: 2, curve }),
      ],
      gradients: [
        {
          id: "dash-total-fill",
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 1,
          stops: [
            { offset: 0, color: "var(--ink)", opacity: 0.06 },
            { offset: 1, color: "var(--ink)", opacity: 0 },
          ],
        },
        {
          id: "dash-completed-fill",
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 1,
          stops: [
            { offset: 0, color: "var(--badge-blue-fg)", opacity: 0.22 },
            { offset: 1, color: "var(--badge-blue-fg)", opacity: 0 },
          ],
        },
      ],
      x: {
        scale: () => scalePoint<string>().domain(data.map((row) => row.label)),
        axis: {
          line: false,
          ticks: { size: 0, padding: 8, values: tickValues },
          tickLabels: { fontSize: 11, thin: { priority: "ends" } },
        },
      },
      y: {
        scale: () => scaleLinear().domain([0, maxTotal]),
        nice: true,
        grid: true,
        axis: false,
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
              { label: "Completed", value: String(row.completed) },
              { label: totalLabel, value: String(row.total) },
            ],
          };
        },
      },
    });
  }, [data, totalLabel]);

  if (!definition) return null;

  return (
    <div className="w-full">
      <Chart
        definition={definition}
        height={height}
        ariaLabel={mode === "jd" ? "Job description work due and completed over time" : "Tasks assigned and completed over time"}
      />
    </div>
  );
}
