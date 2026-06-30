export const jdRecurrences = ["daily", "every_other_day", "weekly", "semimonthly", "monthly", "semiannually", "annually"] as const;
export type JdRecurrence = (typeof jdRecurrences)[number];

export type JdCycle = { start: number; end: number };

export const defaultTimeZone = "Etc/GMT-5"; // GMT+5 fallback when the browser/company timezone is unavailable.

const dayMs = 86_400_000;
const mondayAnchorDay = 4; // 1970-01-05, a stable Monday anchor for week windows.
const partFormatters = new Map<string, Intl.DateTimeFormat>();

function timeZoneOrDefault(timeZone?: string | null) {
  if (!timeZone) return defaultTimeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return defaultTimeZone;
  }
}

function floorDiv(value: number, divisor: number) {
  return Math.floor(value / divisor);
}

function formatter(timeZone: string) {
  let existing = partFormatters.get(timeZone);
  if (!existing) {
    existing = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    partFormatters.set(timeZone, existing);
  }
  return existing;
}

function localParts(ms: number, timeZone: string) {
  const values: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) values[part.type] = part.value;
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

function offsetAt(timeZone: string, ms: number) {
  const parts = localParts(ms, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000;
}

function localToUtc(timeZone: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = localAsUtc - offsetAt(timeZone, localAsUtc);
  utc = localAsUtc - offsetAt(timeZone, utc);
  return utc;
}

function localDateFromDayIndex(dayIndex: number) {
  const date = new Date(dayIndex * dayMs);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localDayIndex(parts: { year: number; month: number; day: number }) {
  return floorDiv(Date.UTC(parts.year, parts.month - 1, parts.day), dayMs);
}

function localDateAdd(parts: { year: number; month: number; day: number }, days: number) {
  return localDateFromDayIndex(localDayIndex(parts) + days);
}

function localMonthAdd(parts: { year: number; month: number }, months: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 };
}

function boundaryUtc(timeZone: string, parts: { year: number; month: number; day: number }) {
  return localToUtc(timeZone, parts.year, parts.month, parts.day, 0, 0, 0);
}

export function nextJdCycleStart(start: number, recurrence: JdRecurrence, timeZone?: string | null) {
  const zone = timeZoneOrDefault(timeZone);
  const parts = localParts(start, zone);
  switch (recurrence) {
    case "daily": return boundaryUtc(zone, localDateAdd(parts, 1));
    case "every_other_day": return boundaryUtc(zone, localDateAdd(parts, 2));
    case "weekly": return boundaryUtc(zone, localDateAdd(parts, 7));
    case "semimonthly": return boundaryUtc(zone, parts.day === 1 ? { year: parts.year, month: parts.month, day: 16 } : localMonthAdd(parts, 1));
    case "monthly": return boundaryUtc(zone, localMonthAdd(parts, 1));
    case "semiannually": return boundaryUtc(zone, localMonthAdd(parts, 6));
    case "annually": return boundaryUtc(zone, localMonthAdd(parts, 12));
  }
}

export function previousJdCycleStart(start: number, recurrence: JdRecurrence, timeZone?: string | null) {
  const zone = timeZoneOrDefault(timeZone);
  const parts = localParts(start, zone);
  switch (recurrence) {
    case "daily": return boundaryUtc(zone, localDateAdd(parts, -1));
    case "every_other_day": return boundaryUtc(zone, localDateAdd(parts, -2));
    case "weekly": return boundaryUtc(zone, localDateAdd(parts, -7));
    case "semimonthly": return boundaryUtc(zone, parts.day === 1 ? { ...localMonthAdd(parts, -1), day: 16 } : { year: parts.year, month: parts.month, day: 1 });
    case "monthly": return boundaryUtc(zone, localMonthAdd(parts, -1));
    case "semiannually": return boundaryUtc(zone, localMonthAdd(parts, -6));
    case "annually": return boundaryUtc(zone, localMonthAdd(parts, -12));
  }
}

export function currentJdCycle(recurrence: JdRecurrence, now = Date.now(), timeZone?: string | null): JdCycle {
  const zone = timeZoneOrDefault(timeZone);
  const parts = localParts(now, zone);
  switch (recurrence) {
    case "daily": {
      const start = boundaryUtc(zone, parts);
      return { start, end: nextJdCycleStart(start, recurrence, zone) };
    }
    case "every_other_day": {
      const dayIndex = localDayIndex(parts);
      const startParts = localDateFromDayIndex(floorDiv(dayIndex, 2) * 2);
      const start = boundaryUtc(zone, startParts);
      return { start, end: nextJdCycleStart(start, recurrence, zone) };
    }
    case "weekly": {
      const dayIndex = localDayIndex(parts);
      const startParts = localDateFromDayIndex(mondayAnchorDay + floorDiv(dayIndex - mondayAnchorDay, 7) * 7);
      const start = boundaryUtc(zone, startParts);
      return { start, end: nextJdCycleStart(start, recurrence, zone) };
    }
    case "semimonthly": {
      const start = boundaryUtc(zone, { year: parts.year, month: parts.month, day: parts.day < 16 ? 1 : 16 });
      return { start, end: nextJdCycleStart(start, recurrence, zone) };
    }
    case "monthly": {
      const start = boundaryUtc(zone, { year: parts.year, month: parts.month, day: 1 });
      return { start, end: nextJdCycleStart(start, recurrence, zone) };
    }
    case "semiannually": {
      const start = boundaryUtc(zone, { year: parts.year, month: parts.month < 7 ? 1 : 7, day: 1 });
      return { start, end: nextJdCycleStart(start, recurrence, zone) };
    }
    case "annually": {
      const start = boundaryUtc(zone, { year: parts.year, month: 1, day: 1 });
      return { start, end: nextJdCycleStart(start, recurrence, zone) };
    }
  }
}

export function previousJdCycle(recurrence: JdRecurrence, now = Date.now(), timeZone?: string | null): JdCycle {
  const current = currentJdCycle(recurrence, now, timeZone);
  const start = previousJdCycleStart(current.start, recurrence, timeZone);
  return { start, end: current.start };
}

export function elapsedJdCyclesSince(recurrence: JdRecurrence, activeAt: number, now = Date.now(), maxCycles = 200, timeZone?: string | null): { cycles: JdCycle[]; nextActiveAt: number } {
  const current = currentJdCycle(recurrence, now, timeZone);
  let start = currentJdCycle(recurrence, activeAt, timeZone).start;
  const cycles: JdCycle[] = [];
  while (start < current.start && cycles.length < maxCycles) {
    const end = nextJdCycleStart(start, recurrence, timeZone);
    if (end <= now) cycles.push({ start, end });
    start = end;
  }
  return { cycles, nextActiveAt: start };
}
