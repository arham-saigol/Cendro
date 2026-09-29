import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { TASK_UPLOAD_PROXY_MAX_BYTES } from "../src/lib/task-uploads";

const http = httpRouter();

// Convex httpAction requests are limited to 20 MB; keep headroom under it.
// The upload endpoint exists so a blob's claim binding is proven, not
// asserted: bytes pass through here, the blob is stored, and the claim is
// bound to exactly that blob. The claim's uploadSecret is the credential —
// minted at claim issuance and never exposed by any query.

function corsHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // Only the app's own origin may call this endpoint cross-origin: the
  // uploadSecret is a bearer credential, so echoing every Origin would let
  // any site that learns one spend it from a browser.
  const origin = request.headers.get("Origin");
  const appUrl = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (origin && appUrl && origin === appUrl) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function jsonResponse(status: number, body: Record<string, unknown>, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

http.route({
  path: "/task-uploads",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }),
});

http.route({
  path: "/task-uploads",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const cors = corsHeaders(request);
    const url = new URL(request.url);
    const claimId = url.searchParams.get("claimId");
    const auth = request.headers.get("Authorization");
    const uploadSecret = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;
    if (!claimId || !uploadSecret) return jsonResponse(400, { error: "Missing upload claim." }, cors);

    const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
    if (declaredLength > TASK_UPLOAD_PROXY_MAX_BYTES) {
      return jsonResponse(413, { error: "File exceeds the upload size limit." }, cors);
    }

    // Reject bad credentials before buffering and storing the body — the
    // binding is verified again in commitUploadClaimBlob after the blob
    // exists, but invalid claims must not cost storage operations.
    let claimOk = false;
    try {
      claimOk = await ctx.runQuery(internal.tasks.checkUploadClaim, { claimId: claimId as Id<"taskUploadClaims">, uploadSecret });
    } catch {
      claimOk = false;
    }
    if (!claimOk) return jsonResponse(403, { error: "Upload claim not found." }, cors);

    // Read the body incrementally: without a trustworthy Content-Length,
    // request.blob() would buffer the whole payload before the size check —
    // an oversized upload must be cut off at the cap, not after it lands.
    const stream = request.body;
    let blob: Blob;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let oversize = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > TASK_UPLOAD_PROXY_MAX_BYTES) {
          oversize = true;
          break;
        }
        chunks.push(value);
      }
      if (oversize) {
        await reader.cancel().catch(() => {});
        return jsonResponse(413, { error: "File exceeds the upload size limit." }, cors);
      }
      blob = new Blob(chunks as BlobPart[]);
    } else {
      blob = await request.blob();
      if (blob.size > TASK_UPLOAD_PROXY_MAX_BYTES) {
        return jsonResponse(413, { error: "File exceeds the upload size limit." }, cors);
      }
    }

    // The blob this claim may ever bind to is fixed the moment the bytes are
    // stored: no client-supplied storage id is ever consulted on this path.
    const storageId = await ctx.storage.store(blob);
    try {
      const bound: Id<"_storage"> = await ctx.runMutation(internal.tasks.commitUploadClaimBlob, {
        claimId: claimId as Id<"taskUploadClaims">,
        uploadSecret,
        storageId,
      });
      return jsonResponse(200, { storageId: bound }, cors);
    } catch (error) {
      // The claim rejected the binding (bad/expired secret, consumed claim):
      // reclaim the blob this request just stored so failures never leak
      // storage — and never touch any other blob.
      await ctx.storage.delete(storageId).catch(() => {});
      const message = error instanceof Error && error.message.includes("already bound") ? "Upload claim is already bound." : "Upload claim not found.";
      return jsonResponse(403, { error: message }, cors);
    }
  }),
});

export default http;
