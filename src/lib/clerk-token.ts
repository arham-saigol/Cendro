/**
 * Bounds Clerk's getToken. Internally it waits on an in-flight fetch or the
 * clerk-js token cache with no timeout — when that request never answers (a
 * proxy, VPN, or extension that accepts the connection but never responds, or
 * a stalled internal retry) the returned promise never settles. Convex's auth
 * manager awaits it before anything else, so a hung getToken freezes the whole
 * boot chain on the skeleton screen forever. Racing it against a deadline lets
 * Convex fall back to its own bounded retry and then to a recoverable
 * signed-in-but-unverified state.
 */

export type GetTokenOptions = { template?: string; skipCache?: boolean };
export type GetToken = (options: GetTokenOptions) => Promise<string | null>;

export const CLERK_GET_TOKEN_TIMEOUT_MS = 10_000;

const TIMED_OUT = Symbol("clerk-get-token-timeout");

export function boundGetToken(getToken: GetToken, timeoutMs = CLERK_GET_TOKEN_TIMEOUT_MS): GetToken {
  return async (options) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = getToken(options).then(
      (token) => token,
      () => null,
    );
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const result = await Promise.race([attempt, timeout]);
    clearTimeout(timer);
    if (result === TIMED_OUT) {
      console.warn(`[cendro] sign-in token request did not respond within ${Math.round(timeoutMs / 1000)}s`, {
        template: options?.template ?? "session",
      });
      return null;
    }
    return result;
  };
}
