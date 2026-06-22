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
