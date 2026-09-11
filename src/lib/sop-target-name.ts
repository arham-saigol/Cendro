export type SopTargetNameRow = {
  scopeType?: string | null;
  scopeTargetName?: string | null;
};

/** The one resolution of an SOP's Assigned To text, so sorting and rendering never disagree. */
export function sopTargetName(sop: SopTargetNameRow, companyName?: string) {
  if (typeof sop.scopeTargetName === "string" && sop.scopeTargetName.trim()) return sop.scopeTargetName;
  if (sop.scopeType === "company") return companyName ?? "Company";
  if (sop.scopeType === "branch") return "Unknown branch";
  if (sop.scopeType === "department") return "Unknown department";
  return "Unknown user";
}
