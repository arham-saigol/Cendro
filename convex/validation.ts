import { ConvexError } from "convex/values";

export function nonEmpty(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new ConvexError(`${label} is required.`);
  return trimmed;
}

export function optionalNonEmpty(value: string | undefined, label: string) {
  if (value === undefined) return undefined;
  return nonEmpty(value, label);
}

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ConvexError("Enter a valid email address.");
  return email;
}
