import { describe, expect, test } from "vitest";
import { readJsonRequest } from "./request-body";

describe("bounded JSON request reading", () => {
  test("parses JSON within the byte limit", async () => {
    const request = new Request("https://cendro.test/api", { method: "POST", body: JSON.stringify({ ok: true }) });
    await expect(readJsonRequest(request, 1024)).resolves.toEqual({ ok: true, value: { ok: true } });
  });

  test("rejects a streamed body that exceeds a spoofed content length", async () => {
    const request = new Request("https://cendro.test/api", { method: "POST", headers: { "content-length": "1" }, body: JSON.stringify({ text: "x".repeat(100) }) });
    await expect(readJsonRequest(request, 32)).resolves.toEqual({ ok: false, reason: "too_large" });
  });

  test("rejects invalid JSON", async () => {
    const request = new Request("https://cendro.test/api", { method: "POST", body: "not json" });
    await expect(readJsonRequest(request, 1024)).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});
