export function textOf(message: any) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.parts)) return "";
  return message.parts.map((part: any) => {
    if (part.type === "text") return part.text ?? "";
    if (part.type === "text-delta") return part.text ?? "";
    return "";
  }).join("");
}

export function toUiMessage(row: { _id: string; role: "user" | "assistant" | "tool"; content: string }) {
  return { id: row._id, role: row.role, parts: [{ type: "text", text: row.content }] };
}
