import { afterEach, expect, test, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useCompany, CompanyProvider } from "./company-context";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useConvexConnectionState: () => ({ isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0 }),
  useQuery: () => ({ status: "ready", email: "staff@example.com", companies: [
    { company: { _id: "company-a", name: "A" }, membership: { _id: "member-a", role: "staff", active: true }, capabilities: [] },
  ] }),
}));

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
});

test("a blocked workspace preference cannot prevent a signed-in user from loading their workspace", () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new DOMException("Storage blocked", "SecurityError"); } });
  function Workspace() {
    const { accessStatus, activeCompanyId } = useCompany();
    return React.createElement("div", null, `${accessStatus}:${activeCompanyId}`);
  }
  expect(renderToStaticMarkup(React.createElement(CompanyProvider, null, React.createElement(Workspace)))).toContain("ready:company-a");
});
