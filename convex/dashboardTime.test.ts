import { describe, expect, test } from "vitest";
import { bucketIndexFor, buildDashboardBuckets, resolveDashboardRange } from "./dashboardTime";

const now = Date.UTC(2026, 8, 12, 10); // Sat Sep 12 2026
const timeZone = "UTC";

describe("resolveDashboardRange", () => {
  test("this_week covers the week to date grouped by day", () => {
    const range = resolveDashboardRange({ preset: "this_week" }, now, timeZone);
    expect(range).toEqual({ start: Date.UTC(2026, 8, 7), end: Date.UTC(2026, 8, 13) - 1, grouping: "day" });
    const buckets = buildDashboardBuckets(range, timeZone);
    expect(buckets).toHaveLength(6);
    expect(buckets[0]).toMatchObject({ start: Date.UTC(2026, 8, 7), end: Date.UTC(2026, 8, 8) - 1, label: "Sep 7" });
    expect(buckets[buckets.length - 1]).toMatchObject({ start: Date.UTC(2026, 8, 12), end: Date.UTC(2026, 8, 13) - 1, label: "Sep 12" });
  });

  test("this_month covers the month to date grouped by day", () => {
    const range = resolveDashboardRange({ preset: "this_month" }, now, timeZone);
    expect(range).toEqual({ start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 13) - 1, grouping: "day" });
    expect(buildDashboardBuckets(range, timeZone)).toHaveLength(12);
  });

  test("last_3_months starts two months back and ends today grouped by aligned weeks", () => {
    const range = resolveDashboardRange({ preset: "last_3_months" }, now, timeZone);
    expect(range).toEqual({ start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 8, 13) - 1, grouping: "week" });
    const buckets = buildDashboardBuckets(range, timeZone);
    expect(buckets[0].start).toBe(Date.UTC(2026, 6, 1));
    expect(buckets[0].label).toBe("Jul 1");
    expect(buckets[1].start).toBe(Date.UTC(2026, 6, 6));
    expect(buckets[buckets.length - 1].end).toBe(range.end);
  });

  test("this_year groups the year to date into calendar months", () => {
    const range = resolveDashboardRange({ preset: "this_year" }, now, timeZone);
    expect(range).toEqual({ start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 8, 13) - 1, grouping: "month" });
    const buckets = buildDashboardBuckets(range, timeZone);
    expect(buckets).toHaveLength(9);
    expect(buckets.map((bucket) => bucket.label)).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]);
  });

  test("custom range inside 140 days groups by week", () => {
    const range = resolveDashboardRange({ preset: "custom", startDate: "2025-11-15", endDate: "2026-02-10" }, now, timeZone);
    expect(range.grouping).toBe("week");
    expect(range.start).toBe(Date.UTC(2025, 10, 15));
    expect(range.end).toBe(Date.UTC(2026, 1, 11) - 1);
  });

  test("custom ranges collapse future days onto today", () => {
    const range = resolveDashboardRange({ preset: "custom", startDate: "2026-09-10", endDate: "2026-09-30" }, now, timeZone);
    expect(range.start).toBe(Date.UTC(2026, 8, 10));
    expect(range.end).toBe(Date.UTC(2026, 8, 13) - 1);

    const fully = resolveDashboardRange({ preset: "custom", startDate: "2026-09-20", endDate: "2026-09-30" }, now, timeZone);
    expect(fully).toEqual({ start: Date.UTC(2026, 8, 12), end: Date.UTC(2026, 8, 13) - 1, grouping: "day" });
  });

  test("custom range spanning calendar years labels months with the year", () => {
    const range = resolveDashboardRange({ preset: "custom", startDate: "2024-01-01", endDate: "2026-01-01" }, now, timeZone);
    expect(range.grouping).toBe("month");
    const buckets = buildDashboardBuckets(range, timeZone);
    expect(buckets[0].label).toBe("Jan 24");
    expect(buckets[buckets.length - 1].label).toBe("Jan 26");
  });
});

describe("bucketIndexFor", () => {
  const range = resolveDashboardRange({ preset: "this_week" }, now, timeZone);
  const buckets = buildDashboardBuckets(range, timeZone);

  test("returns -1 outside the range and the bucket index inside it", () => {
    expect(bucketIndexFor(buckets, range.start - 1)).toBe(-1);
    expect(bucketIndexFor(buckets, range.end + 1)).toBe(-1);
    expect(bucketIndexFor(buckets, buckets[3].start + 3_600_000)).toBe(3);
    expect(bucketIndexFor(buckets, range.end)).toBe(buckets.length - 1);
  });
});
