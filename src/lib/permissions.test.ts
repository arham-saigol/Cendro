import { describe, expect, it } from "vitest";
import {
  capabilities,
  defaultRoleCapabilities,
  resolveEffectiveCapabilities,
  getHighestScope,
  type Capability,
} from "./permissions";

describe("permissions catalog and defaults", () => {
  it("defines explicit defaults for Admin containing all capabilities", () => {
    const adminCaps = new Set(defaultRoleCapabilities.Admin);
    expect(adminCaps.size).toBe(capabilities.length);
    for (const cap of capabilities) {
      expect(adminCaps.has(cap)).toBe(true);
    }
  });

  it("defines explicit independent defaults for Manager", () => {
    // Independent expected set (do not derive from implementation)
    const expectedManagerCaps = new Set<Capability>([
      "analytics:view:managed_scope",
      "analytics:view:self",
      "tasks:jd:view:managed",
      "tasks:jd:view:self",
      "tasks:jd:create",
      "tasks:jd:assign:managed",
      "tasks:jd:assign:self",
      "tasks:jd:update:managed",
      "tasks:jd:update:self",
      "tasks:jd:delete:managed",
      "tasks:jd:delete:self",
      "tasks:jd:import",
      "tasks:jd:export",
      "tasks:one_time:view:managed",
      "tasks:one_time:view:self",
      "tasks:one_time:create",
      "tasks:one_time:assign:managed",
      "tasks:one_time:assign:self",
      "tasks:one_time:update:managed",
      "tasks:one_time:update:self",
      "tasks:one_time:delete:managed",
      "tasks:one_time:delete:self",
      "tasks:one_time:import",
      "tasks:one_time:export",
      "tasks:comment",
      "tasks:attachment:add",
      "tasks:attachment:delete:own",
      "tasks:attachment:delete:any",
      "sops:view:managed",
      "sops:view:self",
      "sops:create",
      "sops:manage:branch",
      "sops:manage:department",
      "sops:delete:branch",
      "sops:delete:department",
      "ai:use",
    ]);

    const actual = new Set(defaultRoleCapabilities.Manager);
    expect(actual).toEqual(expectedManagerCaps);
  });

  it("defines explicit independent defaults for Employee", () => {
    const expectedEmployeeCaps = new Set<Capability>([
      "analytics:view:self",
      "tasks:jd:view:self",
      "tasks:jd:update:self",
      "tasks:one_time:view:self",
      "tasks:one_time:update:self",
      "tasks:comment",
      "tasks:attachment:add",
      "sops:view:self",
      "ai:use",
    ]);

    const actual = new Set(defaultRoleCapabilities.Employee);
    expect(actual).toEqual(expectedEmployeeCaps);
    expect(actual.has("tasks:attachment:delete:own")).toBe(false);
    expect(actual.has("tasks:attachment:delete:any")).toBe(false);
  });
});

describe("resolveEffectiveCapabilities", () => {
  it("resolves role defaults when no overrides are present", () => {
    const caps = resolveEffectiveCapabilities("Employee", []);
    expect(caps.has("tasks:comment")).toBe(true);
    expect(caps.has("tasks:jd:create")).toBe(false);
  });

  it("adds capabilities when effect is allow", () => {
    const caps = resolveEffectiveCapabilities("Employee", [
      { capability: "tasks:jd:create", effect: "allow" },
    ]);
    expect(caps.has("tasks:jd:create")).toBe(true);
    expect(caps.has("tasks:comment")).toBe(true);
  });

  it("removes capabilities when effect is deny", () => {
    const caps = resolveEffectiveCapabilities("Admin", [
      { capability: "tasks:jd:create", effect: "deny" },
    ]);
    expect(caps.has("tasks:jd:create")).toBe(false);
    expect(caps.has("tasks:comment")).toBe(true);
  });

  it("resolves duplicate allow/deny deterministically with deny winning", () => {
    // allow first, then deny
    const caps1 = resolveEffectiveCapabilities("Employee", [
      { capability: "tasks:jd:create", effect: "allow" },
      { capability: "tasks:jd:create", effect: "deny" },
    ]);
    expect(caps1.has("tasks:jd:create")).toBe(false);

    // deny first, then allow -> deny must still win!
    const caps2 = resolveEffectiveCapabilities("Employee", [
      { capability: "tasks:jd:create", effect: "deny" },
      { capability: "tasks:jd:create", effect: "allow" },
    ]);
    expect(caps2.has("tasks:jd:create")).toBe(false);
  });

  it("ignores unknown stored capability strings and does not grant access", () => {
    const caps = resolveEffectiveCapabilities("Employee", [
      { capability: "unknown:super:admin", effect: "allow" },
      { capability: "arbitrary_garbage", effect: "allow" },
    ]);
    expect(caps.has("unknown:super:admin" as any)).toBe(false);
    expect(caps.has("arbitrary_garbage" as any)).toBe(false);
  });

  it("handles inherit effect by reverting to role default", () => {
    const caps = resolveEffectiveCapabilities("Employee", [
      { capability: "tasks:comment", effect: "inherit" },
    ]);
    expect(caps.has("tasks:comment")).toBe(true);
  });
});

describe("scope precedence helper", () => {
  it("determines highest scope correctly in any > managed > self order", () => {
    expect(getHighestScope(["any", "managed", "self"])).toBe("any");
    expect(getHighestScope(["company", "managed"])).toBe("company");
    expect(getHighestScope(["managed", "self"])).toBe("managed");
    expect(getHighestScope(["self"])).toBe("self");
    expect(getHighestScope([])).toBe(null);
  });
});
