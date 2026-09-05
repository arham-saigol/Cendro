/**
 * AI Chat server persistence HMAC verification and signing.
 * Uses Web Crypto API (supported in Node.js and Convex runtimes).
 */

export function createAiPersistencePayload(params: {
  companyId: string;
  sessionId: string;
  role: string;
  timestamp: number;
  requestId: string;
  content: string;
}): string {
  return JSON.stringify([
    params.companyId,
    params.sessionId,
    params.role,
    params.timestamp,
    params.requestId,
    params.content,
  ]);
}

export async function signAiPersistencePayload(
  secret: string,
  payload: string
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyAiPersistenceSignature(
  secret: string,
  payload: string,
  signatureHex: string
): Promise<boolean> {
  try {
    if (!signatureHex || typeof signatureHex !== "string" || signatureHex.length !== 64) {
      return false;
    }
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = new Uint8Array(
      signatureHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []
    );
    return await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payload));
  } catch {
    return false;
  }
}
