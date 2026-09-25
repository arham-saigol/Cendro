"use client";

import { useSyncExternalStore } from "react";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

// True when the primary input is touch — used to swap hover-only affordances
// for always-visible, tap-sized controls without changing desktop behavior.
export function useIsCoarsePointer() {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(COARSE_POINTER_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(COARSE_POINTER_QUERY).matches,
    () => false,
  );
}
