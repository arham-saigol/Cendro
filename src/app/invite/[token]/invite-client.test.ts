import { afterEach, beforeEach, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexError } from "convex/values";
import { createMockElement } from "@/components/app/test-dom";
import { InviteClient } from "./invite-client";

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  push: vi.fn(),
  preview: { companyName: "Company", role: "Admin", expiresAt: 0 },
  isSignedIn: true,
}));
vi.mock("@clerk/nextjs", () => ({ useUser: () => ({ isLoaded: true, isSignedIn: mocks.isSignedIn }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: mocks.isSignedIn }),
  useQuery: () => mocks.preview,
  useMutation: () => mocks.accept,
}));

let root: Root | undefined;
let container: ReturnType<typeof createMockElement>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  mocks.preview.expiresAt = Date.now() + 14 * 86_400_000;
  mocks.accept.mockReset();
  mocks.push.mockReset();
  mocks.isSignedIn = true;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});

function nodes(node: any): any[] { return [node, ...(node.children ?? []).flatMap(nodes)]; }
function text(node: any): string {
  return node.nodeValue ?? (node.children?.length ? node.children.map(text).join("") : node.textContent ?? "");
}
async function mount() {
  container = createMockElement();
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(InviteClient, { token: "invite-token" })));
}
function acceptButton() {
  return nodes(container).find((node) => node.tagName === "BUTTON" && text(node) === "Accept invitation");
}
async function accept() {
  const button = acceptButton();
  expect(button).toBeDefined();
  await act(async () => button.dispatchEvent(new Event("click", { bubbles: true })));
}

test("acceptance displays Convex application errors, announces them, and permits retry", async () => {
  const failure = new ConvexError("This invitation was sent to a different email address.");
  // Production's transport message does not contain the application payload.
  failure.message = "[CONVEX M(invitations:accept)] [Request ID: abc] Server Error Called by client";
  mocks.accept.mockRejectedValueOnce(failure).mockResolvedValueOnce({ companyId: "company" });
  await mount();
  await accept();
  const alert = nodes(container).find((node) => node.getAttribute?.("role") === "alert");
  expect(text(alert)).toBe("This invitation was sent to a different email address.");
  expect(text(container)).not.toContain("Server Error");
  expect(mocks.push).not.toHaveBeenCalled();
  await accept();
  expect(mocks.push).toHaveBeenCalledWith("/dashboard");
  expect(nodes(container).some((node) => node.getAttribute?.("role") === "alert")).toBe(false);
});

test("unexpected acceptance failures show safe recovery guidance rather than transport details", async () => {
  mocks.accept.mockRejectedValue(new Error("private backend stack"));
  await mount();
  await accept();
  expect(text(container)).toContain("Could not accept invitation. Please try again. If the problem continues, contact your company admin.");
  expect(text(container)).not.toContain("private backend stack");
  expect(acceptButton()).toBeDefined();
});

test("a fast device clock does not block sign-in or acceptance of a server-valid invite", async () => {
  const serverNow = Date.UTC(2026, 0, 1);
  mocks.preview.expiresAt = serverNow + 60_000;
  vi.setSystemTime(serverNow + 5 * 60_000);
  mocks.isSignedIn = false;
  mocks.accept.mockResolvedValue({ companyId: "company" });
  await mount();
  expect(text(container)).toContain("Sign in");
  expect(text(container)).toContain("Create account");
  expect(text(container)).not.toContain("This invitation has expired.");

  mocks.isSignedIn = true;
  await act(async () => root!.render(React.createElement(InviteClient, { token: "invite-token" })));
  await accept();
  expect(mocks.push).toHaveBeenCalledWith("/dashboard");
});

test("a slow device clock still displays the server's authoritative expiry rejection", async () => {
  const serverNow = Date.UTC(2026, 0, 1);
  mocks.preview.expiresAt = serverNow - 1;
  vi.setSystemTime(serverNow - 5 * 60_000);
  mocks.accept.mockRejectedValue(new ConvexError("This invitation has expired."));
  await mount();
  await accept();
  const alert = nodes(container).find((node) => node.getAttribute?.("role") === "alert");
  expect(text(alert)).toBe("This invitation has expired.");
  expect(mocks.push).not.toHaveBeenCalled();
});
