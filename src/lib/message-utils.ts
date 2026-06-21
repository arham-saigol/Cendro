const STORED_ASSISTANT_MESSAGE_KIND = "cendro-ai-message";
const STORED_ASSISTANT_MESSAGE_VERSION = 1;
const MAX_STORED_THINKING_CHARS = 20_000;
const MAX_STORED_PARTS = 80;

type StoredAssistantMessage = {
  kind: typeof STORED_ASSISTANT_MESSAGE_KIND;
  version: typeof STORED_ASSISTANT_MESSAGE_VERSION;
  text: string;
  parts: any[];
};

function compactText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function toolNameOfPart(part: any) {
  const type = String(part?.type ?? "");
  if (type.startsWith("tool-")) return type.slice(5);
  if (type === "dynamic-tool") return String(part.toolName ?? "");
  return "";
}

function safeToolInput(part: any, toolName: string) {
  const input = part?.input;
  if (toolName === "web_search" || toolName === "search_sops") return { query: compactText(input?.query, 300) ?? "" };
  if (toolName === "web_fetch") return { url: compactText(input?.url, 1000) ?? "" };
  return undefined;
}

function safeToolOutput(part: any, toolName: string) {
  const output = part?.output;
  if (toolName === "web_search" && Array.isArray(output?.results)) return { results: output.results.slice(0, 10).map(() => ({})) };
  if (toolName === "web_fetch") return { page: { title: compactText(output?.page?.title, 160) ?? "" } };
  return undefined;
}

function safeStoredPart(part: any): any | null {
  if (part?.type === "text") {
    const text = compactText(part.text, 200_000);
    return text ? { type: "text", text, state: "done" } : null;
  }

  if (part?.type === "reasoning") {
    const text = compactText(part.text, MAX_STORED_THINKING_CHARS);
    return text ? { type: "reasoning", text, state: "done" } : null;
  }

  if (part?.type === "step-start") return { type: "step-start" };

  const toolName = toolNameOfPart(part);
  if (!toolName) return null;
  const state = part?.state === "output-error" || part?.state === "output-denied" ? part.state : "output-available";
  return {
    type: String(part.type ?? `tool-${toolName}`),
    ...(part?.type === "dynamic-tool" ? { toolName } : {}),
    toolCallId: String(part.toolCallId ?? `${toolName}:${Math.random().toString(36).slice(2)}`),
    title: typeof part.title === "string" ? compactText(part.title, 120) : undefined,
    state,
    input: safeToolInput(part, toolName),
    output: state === "output-available" ? safeToolOutput(part, toolName) : undefined,
    errorText: state === "output-error" && typeof part.errorText === "string" ? compactText(part.errorText, 200) : undefined,
  };
}

function parseStoredAssistantMessage(content: string): StoredAssistantMessage | null {
  if (!content.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content) as Partial<StoredAssistantMessage>;
    if (parsed.kind !== STORED_ASSISTANT_MESSAGE_KIND || parsed.version !== STORED_ASSISTANT_MESSAGE_VERSION) return null;
    if (typeof parsed.text !== "string" || !Array.isArray(parsed.parts)) return null;
    return { kind: STORED_ASSISTANT_MESSAGE_KIND, version: STORED_ASSISTANT_MESSAGE_VERSION, text: parsed.text, parts: parsed.parts };
  } catch {
    return null;
  }
}

export function textOf(message: any) {
  if (!message) return "";
  if (typeof message.content === "string") return textFromStoredContent(message.content);
  if (!Array.isArray(message.parts)) return "";
  return message.parts.map((part: any) => {
    if (part.type === "text") return part.text ?? "";
    if (part.type === "text-delta") return part.text ?? "";
    return "";
  }).join("");
}

export function textFromStoredContent(content: string) {
  return parseStoredAssistantMessage(content)?.text ?? content;
}

export function serializeAssistantMessage(message: any) {
  const text = textOf(message).trim();
  const parts: any[] = (Array.isArray(message?.parts) ? message.parts : [])
    .map(safeStoredPart)
    .filter((part: any | null): part is any => part !== null)
    .slice(0, MAX_STORED_PARTS);

  if (!parts.some((part) => part.type === "text") && text) parts.push({ type: "text", text, state: "done" });

  return JSON.stringify({
    kind: STORED_ASSISTANT_MESSAGE_KIND,
    version: STORED_ASSISTANT_MESSAGE_VERSION,
    text,
    parts,
  } satisfies StoredAssistantMessage);
}

export function toUiMessage(row: { _id: string; role: "user" | "assistant" | "tool"; content: string; createdAt?: number }) {
  const stored = row.role === "assistant" ? parseStoredAssistantMessage(row.content) : null;
  if (stored) return { id: row._id, role: row.role, parts: stored.parts.length ? stored.parts : [{ type: "text", text: stored.text }], createdAt: row.createdAt };
  return { id: row._id, role: row.role, parts: [{ type: "text", text: row.content }], createdAt: row.createdAt };
}

export function toModelMessage(row: { _id: string; role: "user" | "assistant" | "tool"; content: string }) {
  return { id: row._id, role: row.role, parts: [{ type: "text", text: textFromStoredContent(row.content) }] };
}
