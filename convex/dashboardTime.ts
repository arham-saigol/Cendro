import { ConvexError, v, type Infer } from "convex/values";
import {
  currentJdCycle,
  localDayStart,
  nextJdCycleStart,
  previousJdCycleStart,
  timeZoneOrDefault,
  type JdRecurrence,
} from "./taskCycles";

export const dashboardRangeValidator = v.union(
  v.object({
    preset: v.union(
      v.literal("this_week"),
      v.literal("this_month"),
      v.literal("last_3_months"),
      v.literal("this_year"),
    ),
  }),
  v.object({
    preset: v.literal("custom"),
    startDate: v.string(),
    endDate: v.string(),
  }),
);
export type DashboardRangeArg = Infer<typeof dashboardRangeValidator>;

export type DashboardGrouping = "day" | "week" | "month";
export type DashboardRange = { start: number; end: number; grouping: DashboardGrouping };
export type DashboardBucket = { start: number; end: number; label: string };

const dayMs = 86_400_000;
const customDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const labelFormatters = new Map<string, Intl.DateTimeFormat>();

function labelFormatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let formatter = labelFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    labelFormatters.set(key, formatter);
  }
  return formatter;
}

function customDayStart(timeZone: string | null | undefined, value: string) {
  const match = customDatePattern.exec(value);
  if (!match) return null;
  return localDayStart(timeZone, Number(match[1]), Number(match[2]), Number(match[3]));
}

export function resolveDashboardRange(
  arg: DashboardRangeArg,
  now: number,
  timeZone: string | null | undefined,
): DashboardRange {
  let start: number;
  let end: number;
  if (arg.preset === "custom") {
    const customStart = customDayStart(timeZone, arg.startDate);
    const endDayStart = customDayStart(timeZone, arg.endDate);
    if (customStart === null || endDayStart === null) throw new ConvexError("Invalid date range.");
    if (customStart > endDayStart) throw new ConvexError("Invalid date range.");
    // The two dates may span at most two years (a leap-inclusive 731 days).
    if (endDayStart - customStart > 731 * dayMs) throw new ConvexError("Date range cannot exceed two years.");
    // Custom ranges are also to-date: a selected day after today collapses
    // onto today so callers cannot read future calendar periods.
    const todayStart = currentJdCycle("daily", now, timeZone).start;
    start = Math.min(customStart, todayStart);
    end = nextJdCycleStart(Math.min(endDayStart, todayStart), "daily", timeZone) - 1;
  } else {
    if (arg.preset === "this_week") {
      start = currentJdCycle("weekly", now, timeZone).start;
    } else if (arg.preset === "this_month") {
      start = currentJdCycle("monthly", now, timeZone).start;
    } else if (arg.preset === "last_3_months") {
      const current = currentJdCycle("monthly", now, timeZone).start;
      start = previousJdCycleStart(previousJdCycleStart(current, "monthly", timeZone), "monthly", timeZone);
    } else {
      start = currentJdCycle("annually", now, timeZone).start;
    }
    // Named presets are to-date: the window ends today, not at the end of the
    // calendar period.
    end = currentJdCycle("daily", now, timeZone).end - 1;
  }
  const days = Math.round((end - start + 1) / dayMs);
  const grouping: DashboardGrouping = days <= 31 ? "day" : days <= 140 ? "week" : "month";
  return { start, end, grouping };
}

export function buildDashboardBuckets(
  range: DashboardRange,
  timeZone: string | null | undefined,
): DashboardBucket[] {
  const zone = timeZoneOrDefault(timeZone);
  const unit: JdRecurrence = range.grouping === "day" ? "daily" : range.grouping === "week" ? "weekly" : "monthly";
  const buckets: DashboardBucket[] = [];
  let cursor = range.start;
  let boundary = nextJdCycleStart(currentJdCycle(unit, range.start, zone).start, unit, zone);
  while (boundary <= range.end) {
    buckets.push({ start: cursor, end: boundary - 1, label: "" });
    cursor = boundary;
    boundary = nextJdCycleStart(boundary, unit, zone);
  }
  buckets.push({ start: cursor, end: range.end, label: "" });

  let formatter: Intl.DateTimeFormat;
  if (range.grouping === "month") {
    const year = labelFormatter(zone, { year: "numeric" });
    const spansYears = year.format(range.start) !== year.format(range.end);
    formatter = spansYears
      ? labelFormatter(zone, { month: "short", year: "2-digit" })
      : labelFormatter(zone, { month: "short" });
  } else {
    formatter = labelFormatter(zone, { month: "short", day: "numeric" });
  }
  for (const bucket of buckets) bucket.label = formatter.format(bucket.start);
  return buckets;
}

export function bucketIndexFor(buckets: DashboardBucket[], at: number): number {
  let low = 0;
  let high = buckets.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (buckets[mid].start <= at) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (index === -1 || at > buckets[index].end) return -1;
  return index;
}
