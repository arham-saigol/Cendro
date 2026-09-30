import { afterEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ sessionId: "session-1" as string | null, upgrade: vi.fn(async () => new Response(null, { status: 204 })) }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => state }));
vi.mock("@vercel/functions", () => ({ experimental_upgradeWebSocket: state.upgrade }));
import { GET } from "./route";

const context = (version = "1.46.0") => ({ params: Promise.resolve({ version }) });
const request = (origin = "https://www.cendro.app", upgrade = "websocket") => new Request("https://www.cendro.app/api/convex-relay/1.46.0?target=wss://attacker.example", { headers: { origin, upgrade } });
afterEach(() => { state.sessionId = "session-1"; state.upgrade.mockClear(); vi.unstubAllEnvs(); });

test("only a signed-in same-origin upgrade with a valid fixed deployment reaches the relay", async () => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://happy-otter-123.convex.cloud");
  expect((await GET(request("https://other.example"), context())).status).toBe(403);
  expect((await GET(request("https://www.cendro.app", ""), context())).status).toBe(426);
  state.sessionId = null;
  expect((await GET(request(), context())).status).toBe(401);
  state.sessionId = "session-1";
  expect((await GET(request(), context("../other"))).status).toBe(400);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://attacker.example");
  expect((await GET(request(), context())).status).toBe(503);
  expect(state.upgrade).not.toHaveBeenCalled();
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://happy-otter-123.convex.cloud");
  expect((await GET(request(), context())).status).toBe(204);
  expect(state.upgrade).toHaveBeenCalledOnce();
});
