export function textOf(message: any) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.parts)) return "";
  return message.parts.map((part: any) => part.type === "text" ? part.text : part.type?.startsWith("tool-") ? `[Tool: ${part.type.replace("tool-", "")}]` : "").join("");
}

export function toUiMessage(row: { _id: string; role: "user" | "assistant" | "tool"; content: string }) {
  return { id: row._id, role: row.role, parts: [{ type: "text", text: row.content }] };
}
