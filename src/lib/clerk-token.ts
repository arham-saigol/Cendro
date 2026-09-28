/**
 * Bounds Clerk's getToken. Internally it waits on an in-flight fetch or the
 * clerk-js token cache with no timeout. Convex awaits it before continuing
 * authentication; the deadline allows terminal retry without claiming that
 * token acquisition or a network filter caused any particular incident.
 * The race does not abort the underlying Clerk request.
 */

import { recordToken, safeTokenError } from "./auth-diagnostics";

export type GetTokenOptions = { template?: string; skipCache?: boolean };
export type GetToken = (options: GetTokenOptions) => Promise<string | null>;

export const CLERK_GET_TOKEN_TIMEOUT_MS = 10_000;

const TIMED_OUT = Symbol("clerk-get-token-timeout");

export function boundGetToken(getToken: GetToken, timeoutMs = CLERK_GET_TOKEN_TIMEOUT_MS): GetToken {
  return async (options) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const attempt = Promise.resolve().then(() => getToken(options)).then(
      (token) => ({ ok: true as const, token }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const result = await Promise.race([attempt, timeout]);
    clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    const refresh = options.skipCache === true;
    if (result === TIMED_OUT) {
      recordToken({ result: "timeout", durationMs, refresh });
      return null;
    }
    if (!result.ok) {
      recordToken({ result: "rejected", durationMs, refresh, ...safeTokenError(result.error) });
      return null;
    }
    recordToken({ result: result.token ? "obtained" : "empty", durationMs, refresh });
    return result.token;
  };
}
