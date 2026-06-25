"use client";

import { Bold, Heading1, Italic } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { cn } from "@/lib/utils";

const toolbarWidth = 104;

type ToolbarState = {
  visible: boolean;
  left: number;
  top: number;
  bold: boolean;
  italic: boolean;
  h1: boolean;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdownToHtml(value: string) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+?)_/g, "$1<em>$2</em>");
}

export function markdownToRichHtml(value: string) {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;

  function closeList() {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);

    if (!trimmed) {
      closeList();
      continue;
    }

    if (unordered || ordered) {
      const nextList = unordered ? "ul" : "ol";
      if (list !== nextList) {
        closeList();
        html.push(`<${nextList}>`);
        list = nextList;
      }
      html.push(`<li>${inlineMarkdownToHtml((unordered ?? ordered)?.[1] ?? "")}</li>`);
      continue;
    }

    closeList();
    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
    } else {
      html.push(`<p>${inlineMarkdownToHtml(trimmed)}</p>`);
    }
  }

  closeList();
  return html.join("");
}

export function richTextPlainText(value: string) {
  return value
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/__([^_]+?)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+?)_/g, "$1$2")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function textFromNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.replace(/\u00a0/g, " ") ?? "";
  if (!(node instanceof HTMLElement)) return "";

  const content = Array.from(node.childNodes).map(textFromNode).join("");
  const tag = node.tagName.toLowerCase();
  if (tag === "strong" || tag === "b") return content.trim() ? `**${content}**` : "";
  if (tag === "em" || tag === "i") return content.trim() ? `*${content}*` : "";
  if (tag === "br") return "\n";
  return content;
}

function blockFromNode(node: Node, index = 0): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim();
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  const inline = Array.from(node.childNodes).map(textFromNode).join("").trim();

  if (!inline && tag !== "br") return "";
  if (tag === "h1") return `# ${inline}`;
  if (tag === "h2") return `## ${inline}`;
  if (tag === "h3") return `### ${inline}`;
  if (tag === "li") return `- ${inline}`;
  if (tag === "ul") return Array.from(node.children).map((child) => `- ${Array.from(child.childNodes).map(textFromNode).join("").trim()}`).filter(Boolean).join("\n");
  if (tag === "ol") return Array.from(node.children).map((child, childIndex) => `${childIndex + 1}. ${Array.from(child.childNodes).map(textFromNode).join("").trim()}`).filter(Boolean).join("\n");
  if (tag === "br") return "";
  if (tag === "p" || tag === "div" || tag === "section") return inline;

  return Array.from(node.childNodes).map((child, childIndex) => blockFromNode(child, childIndex)).filter(Boolean).join("\n\n") || (index >= 0 ? inline : "");
}

function htmlToMarkdown(html: string) {
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, "").trim();
  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(template.content.childNodes)
    .map((node, index) => blockFromNode(node, index))
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function selectionInside(editor: HTMLElement, selection: Selection | null) {
  if (!selection?.anchorNode || !selection.focusNode) return false;
  return editor.contains(selection.anchorNode) && editor.contains(selection.focusNode);
}

function closestElement(node: Node | null, editor: HTMLElement) {
  let current: Node | null = node;
  while (current && current !== editor) {
    if (current instanceof HTMLElement) return current;
    current = current.parentNode;
  }
  return null;
}

function closestBlock(node: Node | null, editor: HTMLElement) {
  let current = closestElement(node, editor);
  while (current && current !== editor) {
    if (["H1", "H2", "H3", "P", "DIV", "LI"].includes(current.tagName)) return current;
    current = current.parentElement;
  }
  return editor;
}

function closestTag(node: Node | null, editor: HTMLElement, tags: string[]) {
  let current = closestElement(node, editor);
  while (current && current !== editor) {
    if (tags.includes(current.tagName)) return current;
    current = current.parentElement;
  }
  return null;
}

function selectionHasTag(editor: HTMLElement, selection: Selection | null, tags: string[]) {
  return Boolean(closestTag(selection?.anchorNode ?? null, editor, tags) || closestTag(selection?.focusNode ?? null, editor, tags));
}

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function unwrapElement(element: HTMLElement) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function toggleInlineTag(editor: HTMLElement, tagName: "strong" | "em") {
  const selection = window.getSelection();
  if (!selectionInside(editor, selection) || !selection?.rangeCount) return;
  const active = closestTag(selection.anchorNode, editor, [tagName.toUpperCase(), tagName === "strong" ? "B" : "I"]);
  if (active) { unwrapElement(active); return; }
  if (selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const wrapper = document.createElement(tagName);
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);
  selection.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(wrapper);
  selection.addRange(nextRange);
}

function setBlockTag(editor: HTMLElement, tagName: "p" | "h1") {
  const selection = window.getSelection();
  if (!selectionInside(editor, selection) || !selection?.rangeCount) return;
  const block = closestBlock(selection.anchorNode, editor);
  const next = document.createElement(tagName);
  if (block === editor) {
    while (editor.firstChild) next.appendChild(editor.firstChild);
    if (!next.childNodes.length) next.appendChild(document.createElement("br"));
    editor.appendChild(next);
  } else {
    next.innerHTML = block.innerHTML || "<br>";
    block.replaceWith(next);
  }
  placeCaretAtEnd(next);
}

export function SopRichTextViewer({ value, placeholder }: { value: string; placeholder?: string }) {
  if (!richTextPlainText(value)) return <p className="text-[14px] leading-7 text-[var(--ink-faint)]">{placeholder}</p>;
  // markdownToRichHtml escapes user text before reintroducing the limited tags rendered here.
  return <div className="sop-rich-content" dangerouslySetInnerHTML={{ __html: markdownToRichHtml(value) }} />;
}

export function SopRichTextEditor({
  value,
  placeholder,
  className,
  ariaLabel,
  onChange,
  onFocus,
  onBlur,
  onEscape,
}: {
  value: string;
  placeholder: string;
  className?: string;
  ariaLabel?: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onEscape?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const lastEmittedRef = useRef(value);
  const [focused, setFocused] = useState(false);
  const [toolbar, setToolbar] = useState<ToolbarState>({ visible: false, left: 0, top: 0, bold: false, italic: false, h1: false });

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (focused && value === lastEmittedRef.current) return;
    editor.innerHTML = value ? markdownToRichHtml(value) : "";
    lastEmittedRef.current = value;
  }, [focused, value]);

  function emitChange() {
    const editor = editorRef.current;
    if (!editor) return;
    const next = htmlToMarkdown(editor.innerHTML);
    lastEmittedRef.current = next;
    onChange(next);
  }

  const updateToolbar = useCallback(() => {
    const wrap = wrapRef.current;
    const editor = editorRef.current;
    if (!wrap || !editor || typeof window === "undefined") return;
    const selection = window.getSelection();
    if (!focused || !selectionInside(editor, selection) || !selection?.rangeCount || selection.isCollapsed || selection.toString().trim() === "") {
      selectionRangeRef.current = null;
      setToolbar((current) => ({ ...current, visible: false }));
      return;
    }

    const range = selection.getRangeAt(0);
    const activeBlock = closestBlock(selection.anchorNode, editor);
    let rect = range.getBoundingClientRect();
    if (!rect || rect.width + rect.height === 0) rect = activeBlock.getBoundingClientRect();
    if (!rect || rect.width + rect.height === 0) rect = editor.getBoundingClientRect();
    selectionRangeRef.current = range.cloneRange();

    const wrapRect = wrap.getBoundingClientRect();
    const left = Math.max(0, Math.min(wrapRect.width - toolbarWidth, rect.left - wrapRect.left + rect.width / 2 - toolbarWidth / 2));
    const preferredTop = rect.top - wrapRect.top - 46;
    const top = preferredTop >= 0 ? preferredTop : rect.bottom - wrapRect.top + 8;

    setToolbar({
      visible: true,
      left,
      top,
      bold: selectionHasTag(editor, selection, ["STRONG", "B"]),
      italic: selectionHasTag(editor, selection, ["EM", "I"]),
      h1: activeBlock.tagName === "H1",
    });
  }, [focused]);

  useEffect(() => {
    if (!focused || typeof document === "undefined") return;
    const handleUpdate = () => updateToolbar();
    document.addEventListener("selectionchange", handleUpdate);
    window.addEventListener("resize", handleUpdate);
    window.addEventListener("scroll", handleUpdate, true);
    return () => {
      document.removeEventListener("selectionchange", handleUpdate);
      window.removeEventListener("resize", handleUpdate);
      window.removeEventListener("scroll", handleUpdate, true);
    };
  }, [focused, updateToolbar]);

  function runCommand(command: "bold" | "italic" | "formatBlock", value?: string) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    const range = selectionRangeRef.current;
    if (selection && range) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (command === "bold") toggleInlineTag(editor, "strong");
    else if (command === "italic") toggleInlineTag(editor, "em");
    else setBlockTag(editor, value === "h1" ? "h1" : "p");
    emitChange();
    updateToolbar();
  }

  function toggleHeading() {
    runCommand("formatBlock", toolbar.h1 ? "p" : "h1");
  }

  function handleToolbarMouseDown(event: MouseEvent<HTMLButtonElement>, command: "bold" | "italic" | "heading") {
    event.preventDefault();
    event.stopPropagation();
    if (command === "heading") toggleHeading();
    else runCommand(command);
  }

  function handleFocus() {
    setFocused(true);
    onFocus?.();
    window.setTimeout(updateToolbar, 0);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null;
    if (event.currentTarget.contains(next)) return;
    if (next && toolbarRef.current?.contains(next)) return;
    setFocused(false);
    setToolbar((current) => ({ ...current, visible: false }));
    if (!richTextPlainText(lastEmittedRef.current)) editorRef.current!.innerHTML = "";
    onBlur?.();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      runCommand("bold");
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      runCommand("italic");
    } else if (event.key === "Escape") {
      onEscape?.();
    }
  }

  const toolbarNode = toolbar.visible ? (
    <div ref={toolbarRef} className="sop-rich-toolbar" style={{ left: toolbar.left, top: toolbar.top }} onMouseDown={(event) => event.preventDefault()}>
      <button type="button" className="sop-rich-toolbar-btn" data-active={toolbar.bold || undefined} aria-label="Bold" onMouseDown={(event) => handleToolbarMouseDown(event, "bold")}><Bold className="h-3.5 w-3.5" /></button>
      <button type="button" className="sop-rich-toolbar-btn" data-active={toolbar.italic || undefined} aria-label="Italic" onMouseDown={(event) => handleToolbarMouseDown(event, "italic")}><Italic className="h-3.5 w-3.5" /></button>
      <button type="button" className="sop-rich-toolbar-btn" data-active={toolbar.h1 || undefined} aria-label="Heading 1" onMouseDown={(event) => handleToolbarMouseDown(event, "heading")}><Heading1 className="h-3.5 w-3.5" /></button>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="sop-rich-editor-wrap">
      <div
        ref={editorRef}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className={cn("sop-rich-editor", className)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onInput={() => { emitChange(); updateToolbar(); }}
        onMouseUp={updateToolbar}
        onKeyUp={updateToolbar}
        onKeyDown={handleKeyDown}
      />
      {toolbarNode}
    </div>
  );
}
