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
        areaY(data, { x: "label", y: "completed", fill: "var(--ink)", fillOpacity: 0.07, curve }),
        lineY(data, { x: "label", y: "total", stroke: "var(--ink-faint)", strokeWidth: 1.5, strokeDasharray: "3 3", curve }),
        lineY(data, { x: "label", y: "completed", stroke: "var(--ink)", strokeWidth: 2, curve }),
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
    <div className="w-full">
      <Chart
        definition={definition}
        height={height}
        ariaLabel={mode === "jd" ? "Job description work due and completed over time" : "Tasks assigned and completed over time"}
      />
    </div>
  );
}
