import { describe, expect, test } from "vitest";
import { AI_CHAT_MAX_ATTACHMENT_BYTES, AI_CHAT_MAX_ATTACHMENTS, validateAiChatAttachments } from "./attachments";

function filePart(mediaType: string, bytes: number) {
  return { type: "file", mediaType, url: `data:${mediaType};base64,${"a".repeat(Math.ceil((bytes * 4) / 3))}` };
}

describe("AI attachment validation", () => {
  test("accepts allowed data URL attachments", () => {
    const result = validateAiChatAttachments([{ role: "user", parts: [filePart("image/png", 12)] }]);
    expect(result).toEqual({ ok: true });
  });

  test("rejects too many attachments", () => {
    const result = validateAiChatAttachments([{ role: "user", parts: Array.from({ length: AI_CHAT_MAX_ATTACHMENTS + 1 }, () => filePart("text/plain", 1)) }]);
    expect(result.ok).toBe(false);
  });

  test("rejects oversized and unsupported attachments", () => {
    expect(validateAiChatAttachments([{ role: "user", parts: [filePart("application/pdf", AI_CHAT_MAX_ATTACHMENT_BYTES + 1)] }]).ok).toBe(false);
    expect(validateAiChatAttachments([{ role: "user", parts: [filePart("application/zip", 10)] }]).ok).toBe(false);
  });
});
