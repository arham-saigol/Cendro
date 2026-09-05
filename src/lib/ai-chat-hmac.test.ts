import { describe, expect, test } from "vitest";
import {
  createAiPersistencePayload,
  signAiPersistencePayload,
  verifyAiPersistenceSignature,
} from "./ai-chat-hmac";

describe("AI chat persistence HMAC", () => {
  const secret = "test-ai-persistence-secret-123456";
  const params = {
    companyId: "comp_123",
    sessionId: "sess_456",
    role: "assistant",
    timestamp: 1700000000000,
    requestId: "req_789",
    content: "Hello from assistant",
  };

  test("signs and verifies valid payload", async () => {
    const payload = createAiPersistencePayload(params);
    const signature = await signAiPersistencePayload(secret, payload);

    expect(signature).toHaveLength(64);
    const isValid = await verifyAiPersistenceSignature(secret, payload, signature);
    expect(isValid).toBe(true);
  });

  test("rejects tampered payload", async () => {
    const payload = createAiPersistencePayload(params);
    const signature = await signAiPersistencePayload(secret, payload);

    const tampered = createAiPersistencePayload({ ...params, content: "Tampered content" });
    const isValid = await verifyAiPersistenceSignature(secret, tampered, signature);
    expect(isValid).toBe(false);
  });

  test("rejects wrong secret", async () => {
    const payload = createAiPersistencePayload(params);
    const signature = await signAiPersistencePayload(secret, payload);

    const isValid = await verifyAiPersistenceSignature("wrong-secret-999999", payload, signature);
    expect(isValid).toBe(false);
  });

  test("rejects malformed signature", async () => {
    const payload = createAiPersistencePayload(params);
    expect(await verifyAiPersistenceSignature(secret, payload, "")).toBe(false);
    expect(await verifyAiPersistenceSignature(secret, payload, "short")).toBe(false);
    expect(await verifyAiPersistenceSignature(secret, payload, "z".repeat(64))).toBe(false);
  });
});
