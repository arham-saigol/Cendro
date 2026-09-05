export const roles = ["Admin", "Manager", "Employee"] as const;
export type Role = (typeof roles)[number];

export const capabilities = [
  "analytics:view:company",
  "analytics:view:managed_scope",
  "analytics:view:self",
  "tasks:jd:view:any",
  "tasks:jd:view:managed",
  "tasks:jd:view:self",
  "tasks:jd:create",
  "tasks:jd:assign:self",
  "tasks:jd:assign:any",
  "tasks:jd:assign:managed",
  "tasks:jd:update:any",
  "tasks:jd:update:managed",
  "tasks:jd:update:self",
  "tasks:jd:delete:any",
  "tasks:jd:delete:managed",
  "tasks:jd:delete:self",
  "tasks:jd:import",
  "tasks:jd:export",
  "tasks:one_time:view:any",
  "tasks:one_time:view:managed",
  "tasks:one_time:view:self",
  "tasks:one_time:create",
  "tasks:one_time:assign:self",
  "tasks:one_time:assign:any",
  "tasks:one_time:assign:managed",
  "tasks:one_time:update:any",
  "tasks:one_time:update:managed",
  "tasks:one_time:update:self",
  "tasks:one_time:delete:any",
  "tasks:one_time:delete:managed",
  "tasks:one_time:delete:self",
  "tasks:one_time:import",
  "tasks:one_time:export",
  "tasks:comment",
  "tasks:attachment:add",
  "tasks:attachment:delete:own",
  "tasks:attachment:delete:any",
  "sops:view:company",
  "sops:view:managed",
  "sops:view:self",
  "sops:create",
  "sops:manage:company",
  "sops:manage:branch",
  "sops:manage:department",
  "sops:manage:user",
  "sops:delete:company",
  "sops:delete:branch",
  "sops:delete:department",
  "sops:delete:user",
  "company:manage_settings",
  "company:manage_branches",
  "company:manage_departments",
  "company:invite_users",
  "company:manage_users",
  "company:manage_permissions",
  "company:view_audit_log",
  "ai:use",
] as const;

export type Capability = (typeof capabilities)[number];

const capabilitySet = new Set<string>(capabilities);

export function isKnownCapability(val: string): val is Capability {
  return capabilitySet.has(val);
}

export const companyManagementCapabilities: Capability[] = [
  "company:manage_settings",
  "company:manage_branches",
  "company:manage_departments",
  "company:invite_users",
  "company:manage_users",
  "company:manage_permissions",
];

export function canViewDashboard(caps: readonly string[] | null | undefined) {
  return Boolean(
    caps?.some(
      (capability) =>
        capability === "analytics:view:self" ||
        capability === "analytics:view:managed_scope" ||
        capability === "analytics:view:company"
    )
  );
}

export function canAccessCompanyManagement(caps: readonly string[] | null | undefined) {
  return Boolean(
    caps?.some((capability) => companyManagementCapabilities.includes(capability as Capability))
  );
}

export const defaultRoleCapabilities: Record<Role, Capability[]> = {
  Admin: [...capabilities],
  Manager: [
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
  ],
  Employee: [
    "analytics:view:self",
    "tasks:jd:view:self",
    "tasks:jd:update:self",
    "tasks:one_time:view:self",
    "tasks:one_time:update:self",
    "tasks:comment",
    "tasks:attachment:add",
    "sops:view:self",
    "ai:use",
  ],
};

export type OverrideEntry = {
  capability: string;
  effect: "allow" | "deny" | "inherit";
};

/**
 * Resolves the effective capabilities for a role given a set of overrides.
 * Rules:
 * - Unknown capabilities in overrides are ignored.
 * - If multiple overrides exist for the same capability, deny wins over allow.
 * - "inherit" falls back to role default.
 */
export function resolveEffectiveCapabilities(
  role: Role,
  overrides: readonly OverrideEntry[]
): Set<Capability> {
  const allowed = new Set<Capability>(defaultRoleCapabilities[role]);

  // Group overrides by capability, only considering known capabilities
  const overrideMap = new Map<Capability, Array<"allow" | "deny" | "inherit">>();
  for (const entry of overrides) {
    if (!isKnownCapability(entry.capability)) continue;
    const list = overrideMap.get(entry.capability);
    if (list) {
      list.push(entry.effect);
    } else {
      overrideMap.set(entry.capability, [entry.effect]);
    }
  }

  for (const [cap, effects] of overrideMap.entries()) {
    if (effects.includes("deny")) {
      allowed.delete(cap);
    } else if (effects.includes("allow")) {
      allowed.add(cap);
    } else if (effects.includes("inherit")) {
      // Revert to role default
      if (defaultRoleCapabilities[role].includes(cap)) {
        allowed.add(cap);
      } else {
        allowed.delete(cap);
      }
    }
  }

  return allowed;
}

export type ScopeLevel = "any" | "company" | "managed" | "self";

/**
 * Returns the highest scope present in the given scope list.
 * Order: "any" > "company" > "managed" > "self".
 */
export function getHighestScope(
  scopes: readonly (ScopeLevel | string)[]
): ScopeLevel | null {
  if (scopes.includes("any")) return "any";
  if (scopes.includes("company")) return "company";
  if (scopes.includes("managed")) return "managed";
  if (scopes.includes("self")) return "self";
  return null;
}

export const capabilityLabels: Record<Capability, string> = {
  "analytics:view:company": "View company dashboard",
  "analytics:view:managed_scope": "View managed dashboard",
  "analytics:view:self": "View own dashboard",
  "tasks:jd:view:any": "View any JD task",
  "tasks:jd:view:managed": "View managed JD tasks",
  "tasks:jd:view:self": "View own JD tasks",
  "tasks:jd:create": "Create JD tasks",
  "tasks:jd:assign:self": "Assign JD tasks to self",
  "tasks:jd:assign:any": "Assign JD tasks to anyone",
  "tasks:jd:assign:managed": "Assign JD tasks to managed people",
  "tasks:jd:update:any": "Edit any JD task",
  "tasks:jd:update:managed": "Edit managed JD tasks",
  "tasks:jd:update:self": "Edit own JD tasks",
  "tasks:jd:delete:any": "Delete any JD task",
  "tasks:jd:delete:managed": "Delete managed JD tasks",
  "tasks:jd:delete:self": "Delete own JD tasks",
  "tasks:jd:import": "Import JD tasks",
  "tasks:jd:export": "Export JD tasks",
  "tasks:one_time:view:any": "View any one-time task",
  "tasks:one_time:view:managed": "View managed one-time tasks",
  "tasks:one_time:view:self": "View own one-time tasks",
  "tasks:one_time:create": "Create one-time tasks",
  "tasks:one_time:assign:self": "Assign one-time tasks to self",
  "tasks:one_time:assign:any": "Assign one-time tasks to anyone",
  "tasks:one_time:assign:managed": "Assign one-time tasks to managed people",
  "tasks:one_time:update:any": "Edit any one-time task",
  "tasks:one_time:update:managed": "Edit managed one-time tasks",
  "tasks:one_time:update:self": "Edit own one-time tasks",
  "tasks:one_time:delete:any": "Delete any one-time task",
  "tasks:one_time:delete:managed": "Delete managed one-time tasks",
  "tasks:one_time:delete:self": "Delete own one-time tasks",
  "tasks:one_time:import": "Import one-time tasks",
  "tasks:one_time:export": "Export one-time tasks",
  "tasks:comment": "Comment on tasks",
  "tasks:attachment:add": "Add task attachments",
  "tasks:attachment:delete:own": "Delete own task attachments",
  "tasks:attachment:delete:any": "Delete any task attachment",
  "sops:view:company": "View company SOPs",
  "sops:view:managed": "View managed SOPs",
  "sops:view:self": "View own SOPs",
  "sops:create": "Create SOPs",
  "sops:manage:company": "Manage company SOPs",
  "sops:manage:branch": "Manage branch SOPs",
  "sops:manage:department": "Manage department SOPs",
  "sops:manage:user": "Manage user SOPs",
  "sops:delete:company": "Delete company SOPs",
  "sops:delete:branch": "Delete branch SOPs",
  "sops:delete:department": "Delete department SOPs",
  "sops:delete:user": "Delete user SOPs",
  "company:manage_settings": "Manage company settings",
  "company:manage_branches": "Manage branches",
  "company:manage_departments": "Manage departments",
  "company:invite_users": "Invite users",
  "company:manage_users": "Manage users",
  "company:manage_permissions": "Manage permissions",
  "company:view_audit_log": "View audit log",
  "ai:use": "Use AI features",
};

export const capabilityGroups: { title: string; capabilities: Capability[] }[] = [
  {
    title: "Dashboard",
    capabilities: [
      "analytics:view:self",
      "analytics:view:managed_scope",
      "analytics:view:company",
    ],
  },
  {
    title: "JD tasks",
    capabilities: [
      "tasks:jd:view:self",
      "tasks:jd:view:managed",
      "tasks:jd:view:any",
      "tasks:jd:create",
      "tasks:jd:assign:self",
      "tasks:jd:assign:managed",
      "tasks:jd:assign:any",
      "tasks:jd:update:self",
      "tasks:jd:update:managed",
      "tasks:jd:update:any",
      "tasks:jd:delete:self",
      "tasks:jd:delete:managed",
      "tasks:jd:delete:any",
      "tasks:jd:import",
      "tasks:jd:export",
    ],
  },
  {
    title: "One-time tasks",
    capabilities: [
      "tasks:one_time:view:self",
      "tasks:one_time:view:managed",
      "tasks:one_time:view:any",
      "tasks:one_time:create",
      "tasks:one_time:assign:self",
      "tasks:one_time:assign:managed",
      "tasks:one_time:assign:any",
      "tasks:one_time:update:self",
      "tasks:one_time:update:managed",
      "tasks:one_time:update:any",
      "tasks:one_time:delete:self",
      "tasks:one_time:delete:managed",
      "tasks:one_time:delete:any",
      "tasks:one_time:import",
      "tasks:one_time:export",
    ],
  },
  {
    title: "Task collaboration",
    capabilities: [
      "tasks:comment",
      "tasks:attachment:add",
      "tasks:attachment:delete:own",
      "tasks:attachment:delete:any",
    ],
  },
  {
    title: "SOPs",
    capabilities: [
      "sops:view:self",
      "sops:view:managed",
      "sops:view:company",
      "sops:create",
      "sops:manage:company",
      "sops:manage:branch",
      "sops:manage:department",
      "sops:manage:user",
      "sops:delete:company",
      "sops:delete:branch",
      "sops:delete:department",
      "sops:delete:user",
    ],
  },
  {
    title: "Company",
    capabilities: [
      "company:manage_settings",
      "company:manage_branches",
      "company:manage_departments",
      "company:invite_users",
      "company:manage_users",
      "company:manage_permissions",
      "company:view_audit_log",
    ],
  },
  {
    title: "AI",
    capabilities: ["ai:use"],
  },
];
