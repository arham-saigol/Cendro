import { describe, expect, it } from "vitest";
import { parsePlatformAdminUserIds, isPlatformAdmin } from "./platform-admin";

describe("platform-admin", () => {
  it("parses comma-separated user IDs, trimming whitespace and removing duplicates", () => {
    const raw = "user_abc, user_def ,user_abc,  user_xyz  ";
    const ids = parsePlatformAdminUserIds(raw);
    expect(ids).toEqual(new Set(["user_abc", "user_def", "user_xyz"]));
  });

  it("handles empty, whitespace, or undefined configuration by returning an empty set", () => {
    expect(parsePlatformAdminUserIds("")).toEqual(new Set());
    expect(parsePlatformAdminUserIds("   ")).toEqual(new Set());
    expect(parsePlatformAdminUserIds(undefined)).toEqual(new Set());
    expect(parsePlatformAdminUserIds(null)).toEqual(new Set());
  });

  it("identifies platform admins correctly", () => {
    const config = "user_123,user_456";
    expect(isPlatformAdmin("user_123", config)).toBe(true);
    expect(isPlatformAdmin("user_456", config)).toBe(true);
    expect(isPlatformAdmin("user_789", config)).toBe(false);
  });

  it("fails closed for missing or empty userId", () => {
    const config = "user_123";
    expect(isPlatformAdmin(null, config)).toBe(false);
    expect(isPlatformAdmin(undefined, config)).toBe(false);
    expect(isPlatformAdmin("", config)).toBe(false);
    expect(isPlatformAdmin("   ", config)).toBe(false);
  });

  it("fails closed for missing configuration", () => {
    expect(isPlatformAdmin("user_123", undefined)).toBe(false);
    expect(isPlatformAdmin("user_123", "")).toBe(false);
  });
});
