"use client";

import { useMemo } from "react";
import { defineChart, lineY, areaY, barX, barY } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleBand } from "@tanstack/charts/scales/band";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/charts/react";

export type TrendMetricMode = "all" | "completed" | "workload" | "overdue";

export type TrendPointData = {
  bucketStart: number;
  label: string;
  completed: number;
  overdue: number;
  workload: number;
};

export type BreakdownItemData = {
  key: string;
  label: string;
  value: number;
  color?: string;
};

/**
 * High-performance, responsive TanStack Trend Chart with multi-series area & line encodings.
 */
export function TanStackTrendChart({
  data,
  mode = "all",
  height = 260,
}: {
  data: TrendPointData[];
  mode?: TrendMetricMode;
  height?: number;
}) {
  const chartDefinition = useMemo(() => {
    if (!data || data.length === 0) return null;

    const marks = [];

    if (mode === "all" || mode === "completed") {
      marks.push(
        areaY(data, {
          x: "label",
          y: "completed",
          fill: "url(#trend-green-grad)",
          opacity: 0.85,
        }),
        lineY(data, {
          x: "label",
          y: "completed",
          stroke: "var(--badge-green-fg, #10b981)",
          strokeWidth: 2.2,
          points: true,
        })
      );
    }

    if (mode === "all" || mode === "workload") {
      if (mode === "workload") {
        marks.push(
          areaY(data, {
            x: "label",
            y: "workload",
            fill: "url(#trend-blue-grad)",
            opacity: 0.75,
          })
        );
      }
      marks.push(
        lineY(data, {
          x: "label",
          y: "workload",
          stroke: "var(--primary, #3b82f6)",
          strokeWidth: 2,
          points: true,
        })
      );
    }

    if (mode === "all" || mode === "overdue") {
      if (mode === "overdue") {
        marks.push(
          areaY(data, {
            x: "label",
            y: "overdue",
            fill: "url(#trend-red-grad)",
            opacity: 0.75,
          })
        );
      }
      marks.push(
        lineY(data, {
          x: "label",
          y: "overdue",
          stroke: "var(--danger, #ef4444)",
          strokeWidth: 2,
          points: true,
        })
      );
    }

    const maxVal = Math.max(
      4,
      ...data.flatMap((d) => [d.completed, d.workload, d.overdue])
    );

    return defineChart({
      marks,
      x: {
        scale: () => scalePoint<string>().domain(data.map((d) => d.label)).padding(0.1),
        axis: {
          ticks: {
            format: (v) => String(v),
          },
        },
      },
      y: {
        scale: () => scaleLinear().domain([0, maxVal]),
        nice: true,
        grid: true,
      },
      gradients: [
        {
          id: "trend-green-grad",
          x1: 0,
          y1: 1,
          x2: 0,
          y2: 0,
          stops: [
            { offset: 0, color: "#10b981", opacity: 0.02 },
            { offset: 1, color: "#10b981", opacity: 0.28 },
          ],
        },
        {
          id: "trend-blue-grad",
          x1: 0,
          y1: 1,
          x2: 0,
          y2: 0,
          stops: [
            { offset: 0, color: "#3b82f6", opacity: 0.02 },
            { offset: 1, color: "#3b82f6", opacity: 0.28 },
          ],
        },
        {
          id: "trend-red-grad",
          x1: 0,
          y1: 1,
          x2: 0,
          y2: 0,
          stops: [
            { offset: 0, color: "#ef4444", opacity: 0.02 },
            { offset: 1, color: "#ef4444", opacity: 0.28 },
          ],
        },
      ],
      tooltip,
    });
  }, [data, mode]);

  if (!chartDefinition) {
    return null;
  }

  return (
    <div className="dash-chart-container w-full">
      <Chart definition={chartDefinition} height={height} ariaLabel="Performance trend chart" />
    </div>
  );
}

/**
 * Horizontal categorical bar chart powered by TanStack Charts for distributions.
 */
export function TanStackHorizontalBarChart({
  data,
  height = 140,
}: {
  data: BreakdownItemData[];
  height?: number;
}) {
  const chartDefinition = useMemo(() => {
    if (!data || data.length === 0) return null;

    const filtered = data.filter((d) => d.value >= 0);

    return defineChart({
      marks: [
        barX(filtered, {
          y: "label",
          x: "value",
          fill: (row) => row.color || "var(--primary, #3b82f6)",
          inset: 2,
        }),
      ],
      y: {
        scale: () => scaleBand<string>().domain(filtered.map((d) => d.label)).padding(0.24),
      },
      x: {
        scale: scaleLinear,
        nice: true,
        grid: true,
      },
      tooltip,
    });
  }, [data]);

  if (!chartDefinition) return null;

  return (
    <div className="dash-chart-container w-full">
      <Chart definition={chartDefinition} height={height} ariaLabel="Distribution bar chart" />
    </div>
  );
}

/**
 * Vertical categorical bar chart powered by TanStack Charts.
 */
export function TanStackVerticalBarChart({
  data,
  height = 160,
}: {
  data: BreakdownItemData[];
  height?: number;
}) {
  const chartDefinition = useMemo(() => {
    if (!data || data.length === 0) return null;

    return defineChart({
      marks: [
        barY(data, {
          x: "label",
          y: "value",
          fill: (row) => row.color || "var(--primary, #3b82f6)",
          inset: 3,
        }),
      ],
      x: {
        scale: () => scaleBand<string>().domain(data.map((d) => d.label)).padding(0.2),
      },
      y: {
        scale: scaleLinear,
        nice: true,
        grid: true,
      },
      tooltip,
    });
  }, [data]);

  if (!chartDefinition) return null;

  return (
    <div className="dash-chart-container w-full">
      <Chart definition={chartDefinition} height={height} ariaLabel="Categorical column chart" />
    </div>
  );
}
