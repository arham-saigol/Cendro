export const AI_CHAT_MAX_ATTACHMENTS = 6;
export const AI_CHAT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const AI_CHAT_MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const AI_CHAT_MAX_REQUEST_BYTES = 24 * 1024 * 1024;

const allowedDocumentMediaTypes = new Set(["application/pdf", "text/plain", "text/markdown", "text/csv"]);

export function isAllowedAiAttachmentMediaType(mediaType: string) {
  return mediaType.startsWith("image/") || allowedDocumentMediaTypes.has(mediaType);
}

export function aiAttachmentLimitsText() {
  return `Attach up to ${AI_CHAT_MAX_ATTACHMENTS} files, ${compactBytes(AI_CHAT_MAX_ATTACHMENT_BYTES)} each and ${compactBytes(AI_CHAT_MAX_TOTAL_ATTACHMENT_BYTES)} total.`;
}

export function compactBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function validateAiAttachmentFile(file: File, currentCount: number, currentTotalBytes: number): { ok: true } | { ok: false; error: string } {
  const mediaType = mediaTypeOfAttachmentFile(file);
  if (currentCount >= AI_CHAT_MAX_ATTACHMENTS) return { ok: false, error: aiAttachmentLimitsText() };
  if (!isAllowedAiAttachmentMediaType(mediaType)) return { ok: false, error: "Attachments must be images, PDFs, or plain text documents." };
  if (file.size > AI_CHAT_MAX_ATTACHMENT_BYTES) return { ok: false, error: `Each attachment must be ${compactBytes(AI_CHAT_MAX_ATTACHMENT_BYTES)} or smaller.` };
  if (currentTotalBytes + file.size > AI_CHAT_MAX_TOTAL_ATTACHMENT_BYTES) return { ok: false, error: `Attachments must be ${compactBytes(AI_CHAT_MAX_TOTAL_ATTACHMENT_BYTES)} or smaller in total.` };
  return { ok: true };
}

export function validateAiChatAttachments(messages: unknown[]): { ok: true } | { ok: false; error: string } {
  const parts = messages.flatMap((message: any) => Array.isArray(message?.parts) ? message.parts.filter((part: any) => part?.type === "file") : []);
  if (parts.length > AI_CHAT_MAX_ATTACHMENTS) return { ok: false, error: aiAttachmentLimitsText() };

  let totalBytes = 0;
  for (const part of parts) {
    const mediaType = typeof part.mediaType === "string" ? part.mediaType : "";
    const url = typeof part.url === "string" ? part.url : typeof part.data === "string" ? part.data : "";
    const dataUrlMediaType = mediaTypeOfDataUrl(url);
    const effectiveMediaType = mediaType || dataUrlMediaType || "";
    if (!url.startsWith("data:") || !dataUrlMediaType) return { ok: false, error: "Attachments must be uploaded as data URLs." };
    if (mediaType && dataUrlMediaType && mediaType !== dataUrlMediaType) return { ok: false, error: "Attachment metadata did not match its data." };
    if (!isAllowedAiAttachmentMediaType(effectiveMediaType)) return { ok: false, error: "Attachments must be images, PDFs, or plain text documents." };

    const bytes = dataUrlByteLength(url);
    if (bytes === null) return { ok: false, error: "Attachment data was invalid." };
    if (bytes > AI_CHAT_MAX_ATTACHMENT_BYTES) return { ok: false, error: `Each attachment must be ${compactBytes(AI_CHAT_MAX_ATTACHMENT_BYTES)} or smaller.` };
    totalBytes += bytes;
    if (totalBytes > AI_CHAT_MAX_TOTAL_ATTACHMENT_BYTES) return { ok: false, error: `Attachments must be ${compactBytes(AI_CHAT_MAX_TOTAL_ATTACHMENT_BYTES)} or smaller in total.` };
  }

  return { ok: true };
}

export function mediaTypeOfAttachmentFile(file: File) {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".csv")) return "text/csv";
  return "text/plain";
}

function mediaTypeOfDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() ?? null;
}

function dataUrlByteLength(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) return null;
  const metadata = dataUrl.slice(5, comma).toLowerCase();
  const payload = dataUrl.slice(comma + 1);
  if (metadata.includes(";base64")) {
    const normalized = payload.replace(/\s/g, "");
    const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).length;
  } catch {
    return new TextEncoder().encode(payload).length;
  }
}
