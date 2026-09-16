/**
 * Lightweight interaction timing. Three phases per interaction:
 * - `paint`: input-to-paint, measured after two animation frames.
 * - `ack`: time until the mutation/request resolves.
 * - `catchup`: time until the subscribed query reflects the change (call when
 *   the authoritative data arrives).
 *
 * No-ops in production unless `localStorage["cendro:perf"] === "1"`, so
 * callsites can stay unconditional.
 */

const PREFIX = "cendro:perf";

function enabled() {
  return typeof window !== "undefined" && (process.env.NODE_ENV === "development" || window.localStorage?.getItem(PREFIX) === "1");
}

function report(label: string, phase: string, ms: number) {
  console.debug(`[perf] ${label}.${phase} ${Math.round(ms)}ms`);
}

export type InteractionTimer = {
  /** Call once; reports input-to-paint latency after the next committed frame. */
  paint(): void;
  /** Time until the request/mutation acknowledges. Returns the elapsed ms. */
  ack(): number;
  /** Time until authoritative state catches up (subscription refresh). */
  catchup(): number;
};

export function startInteraction(label: string): InteractionTimer {
  if (!enabled()) return { paint: () => {}, ack: () => 0, catchup: () => 0 };
  const start = performance.now();
  let painted = false;
  let acked: number | null = null;
  let caughtUp: number | null = null;
  return {
    paint() {
      if (painted) return;
      painted = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => report(label, "paint", performance.now() - start)),
      );
    },
    ack() {
      if (acked !== null) return acked;
      acked = performance.now() - start;
      report(label, "ack", acked);
      return acked;
    },
    catchup() {
      if (caughtUp !== null) return caughtUp;
      caughtUp = performance.now() - start;
      report(label, "catchup", caughtUp);
      return caughtUp;
    },
  };
}
