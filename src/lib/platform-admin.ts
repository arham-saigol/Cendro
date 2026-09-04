/**
 * Platform admin authorization based on stable Clerk user IDs.
 * Parses the comma-separated PLATFORM_ADMIN_CLERK_USER_IDS environment variable.
 */

export function parsePlatformAdminUserIds(
  configValue?: string | null
): Set<string> {
  if (!configValue || typeof configValue !== "string") {
    return new Set();
  }
  const parts = configValue
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return new Set(parts);
}

export function isPlatformAdmin(
  userId: string | null | undefined,
  configValue: string | null | undefined = process.env.PLATFORM_ADMIN_CLERK_USER_IDS
): boolean {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    return false;
  }
  const allowed = parsePlatformAdminUserIds(configValue);
  return allowed.has(userId.trim());
}
