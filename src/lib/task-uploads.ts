import type { Id } from "../../convex/_generated/dataModel";

// Convex HTTP actions cap request size at 20 MB; keep the claim-bound upload
// endpoint comfortably below that. Larger files upload through a generated
// storage URL instead and bind by declared digest — see generateAttachmentUploadUrl.
export const TASK_UPLOAD_PROXY_MAX_BYTES = 19 * 1024 * 1024;

function convexSiteUrl(): string | null {
  const cloud = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!cloud) return null;
  return cloud.replace(".convex.cloud", ".convex.site");
}

// Base64 to match the sha256 encoding Convex records on _storage docs.
async function fileSha256Base64(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export type AttachmentUploadResult = { claimId: Id<"taskUploadClaims">; storageId: Id<"_storage"> };

// Uploads one file under an upload claim and returns the bound blob. The claim
// only ever names a blob whose provenance the backend can prove: small files
// go through the claim-bound endpoint (the endpoint stores the blob, so it is
// the only blob the claim can mean); larger files use a generated storage URL
// and a digest the claim declared before upload.
export async function uploadAttachmentFile(opts: {
  companyId: Id<"companies">;
  file: File;
  generateUploadUrl: (args: { companyId: Id<"companies">; sha256?: string; size?: number }) => Promise<{ url: string; claimId: Id<"taskUploadClaims">; uploadSecret: string }>;
  bindUploadClaim: (args: { companyId: Id<"companies">; claimId: Id<"taskUploadClaims">; storageId: Id<"_storage"> }) => Promise<unknown>;
}): Promise<AttachmentUploadResult> {
  const { companyId, file, generateUploadUrl, bindUploadClaim } = opts;
  if (file.size <= TASK_UPLOAD_PROXY_MAX_BYTES) {
    const claim = await generateUploadUrl({ companyId });
    const site = convexSiteUrl();
    if (!site) throw new Error("Uploads are not configured.");
    const response = await fetch(`${site}/task-uploads?claimId=${encodeURIComponent(claim.claimId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${claim.uploadSecret}`, "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
    const json = (await response.json()) as { storageId?: Id<"_storage"> };
    if (!json.storageId) throw new Error(`Could not upload ${file.name}.`);
    return { claimId: claim.claimId, storageId: json.storageId };
  }
  const sha256 = await fileSha256Base64(file);
  const claim = await generateUploadUrl({ companyId, sha256, size: file.size });
  const response = await fetch(claim.url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
  const json = (await response.json()) as { storageId?: Id<"_storage"> };
  if (!json.storageId) throw new Error(`Could not upload ${file.name}.`);
  await bindUploadClaim({ companyId, claimId: claim.claimId, storageId: json.storageId });
  return { claimId: claim.claimId, storageId: json.storageId };
}
