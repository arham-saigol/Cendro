export const DEFAULT_TIME_ZONE = "Etc/GMT-5";

const fallbackZones = [
  "Etc/GMT-5",
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function timeZoneLabel(timeZone: string) {
  if (timeZone === "Etc/GMT-5") return "GMT+5";
  return timeZone.replace(/_/g, " ");
}

export function timeZoneOptions(current?: string | null) {
  const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : fallbackZones;
  return Array.from(new Set([DEFAULT_TIME_ZONE, current ?? DEFAULT_TIME_ZONE, ...supported].filter(Boolean))).map((value) => ({ value, label: timeZoneLabel(value) }));
}
