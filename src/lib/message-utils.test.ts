import { describe, expect, test } from "vitest";
import { CENDRO_AI_SYSTEM_PROMPT } from "./ai/system-prompt";
import { finalTextOfAssistantMessage, serializeAssistantMessage, textFromStoredContent, toUiMessage, toModelMessage } from "./message-utils";

describe("AI message persistence helpers", () => {
  test("long final responses are preserved without truncation", () => {
    const longText = Array.from({ length: 900 }, (_, index) => `Line ${index + 1}: complete operational detail.`).join("\n");
    const serialized = serializeAssistantMessage({ role: "assistant", parts: [{ type: "text", text: longText }] });

    expect(textFromStoredContent(serialized)).toBe(longText);
    expect(toUiMessage({ _id: "assistant_1", role: "assistant", content: serialized }).parts[0].text).toBe(longText);
  });

  test("oversized responses are truncated inside the JSON envelope, never mid-string", () => {
    const hugeText = "x".repeat(100_000);
    const serialized = serializeAssistantMessage({ role: "assistant", parts: [{ type: "text", text: hugeText }] }, 64_000);

    expect(serialized.length).toBeLessThanOrEqual(64_000);
    const parsed = JSON.parse(serialized);
    expect(parsed.text.length).toBeGreaterThan(0);
    expect(hugeText.startsWith(parsed.text)).toBe(true);
    expect(textFromStoredContent(serialized)).toBe(parsed.text);
    expect(toUiMessage({ _id: "assistant_1", role: "assistant", content: serialized }).parts[0].text).toBe(parsed.text);
  });

  test("escaped characters shrink the kept prefix, never exceed the cap", () => {
    // Escapes expand in the JSON string; a raw-excess slice can erase an
    // answer that mostly fits — binary search keeps the longest prefix.
    const newlineHeavy = "a" + "\n".repeat(35_000) + "x".repeat(40_000);
    const serialized = serializeAssistantMessage({ role: "assistant", parts: [{ type: "text", text: newlineHeavy }] }, 64_000);

    expect(serialized.length).toBeLessThanOrEqual(64_000);
    const text = JSON.parse(serialized).text;
    expect(text.length).toBeGreaterThan(30_000);
    expect(text).toBe("a" + "\n".repeat(text.length - 1));
  });

  test("a truncated multipart answer keeps the same text the model saw", () => {
    // Surviving text parts would mask the stored `text` — they are dropped so
    // the UI falls back to the same trimmed answer the model context uses.
    const serialized = serializeAssistantMessage({
      role: "assistant",
      parts: [
        { type: "text", text: "A".repeat(30_000), state: "done" },
        { type: "text", text: "B".repeat(35_000), state: "done" },
        { type: "reasoning", text: "r".repeat(2_000) },
      ],
    }, 64_000);

    expect(serialized.length).toBeLessThanOrEqual(64_000);
    const parsed = JSON.parse(serialized);
    expect(parsed.parts).toHaveLength(0);
    expect(parsed.text.length).toBeGreaterThan(30_000);
    expect(toUiMessage({ _id: "a", role: "assistant", content: serialized }).parts[0].text).toBe(parsed.text);
  });

  test("budget eviction drops reasoning and tool parts before the final answer part", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "r".repeat(20_000) },
        { type: "tool-list_tasks", toolCallId: "call_1", state: "output-available", input: {}, output: { rows: "o".repeat(10_000) } },
        { type: "text", text: "a".repeat(30_000), state: "done" },
      ],
    };
    const serialized = serializeAssistantMessage(message, 64_000);

    expect(serialized.length).toBeLessThanOrEqual(64_000);
    const ui = toUiMessage({ _id: "assistant_1", role: "assistant", content: serialized });
    expect(ui.parts.some((part: any) => part.type === "text" && part.text === "a".repeat(30_000))).toBe(true);
  });

  test("intermediate assistant output is not treated as the final answer", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Looking at visible tasks." },
        { type: "text", text: "I’ll check the workspace." },
        { type: "tool-list_tasks", toolCallId: "call_1", state: "output-available", input: {}, output: {} },
      ],
    };

    expect(finalTextOfAssistantMessage(message)).toBe("");
  });

  test("tool-call turns persist the final answer after tool output", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "text", text: "I’ll check the workspace." },
        { type: "tool-list_tasks", toolCallId: "call_1", state: "output-available", input: {}, output: {} },
        { type: "text", text: "You have 3 overdue tasks. Start with Payroll Review today." },
      ],
    };

    const serialized = serializeAssistantMessage(message);

    expect(textFromStoredContent(serialized)).toBe("You have 3 overdue tasks. Start with Payroll Review today.");
    expect(toModelMessage({ _id: "assistant_1", role: "assistant", content: serialized }).parts[0].text).toBe("You have 3 overdue tasks. Start with Payroll Review today.");
    expect(toUiMessage({ _id: "assistant_1", role: "assistant", content: serialized }).parts.some((part: any) => part.type === "text" && part.text.includes("I’ll check"))).toBe(false);
  });
});

describe("Cendro AI system prompt", () => {
  test("is concise and permission-aware", () => {
    expect(CENDRO_AI_SYSTEM_PROMPT.length).toBeLessThan(5000);
    expect(CENDRO_AI_SYSTEM_PROMPT).toContain("Admins may receive company-wide");
    expect(CENDRO_AI_SYSTEM_PROMPT).toContain("Managers may receive only their managed scope");
    expect(CENDRO_AI_SYSTEM_PROMPT).toContain("Employees may receive only their own visible work");
    expect(CENDRO_AI_SYSTEM_PROMPT).toContain("Do not stop after reasoning, a preamble, or tool results");
    expect(CENDRO_AI_SYSTEM_PROMPT).toContain("Never infer or reveal hidden records");
    expect(CENDRO_AI_SYSTEM_PROMPT).toContain("Minimize em dashes");
    expect(CENDRO_AI_SYSTEM_PROMPT).toContain("Avoid markdown tables when more than 2 columns would be required");
  });
});
