"use client";

import { useSyncExternalStore } from "react";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

// Stable module-level callbacks: inline functions would resubscribe every row's
// listener on each render.
function subscribe(onChange: () => void) {
  const media = window.matchMedia(COARSE_POINTER_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const getSnapshot = () => window.matchMedia(COARSE_POINTER_QUERY).matches;
const getServerSnapshot = () => false;

// True when the primary input is touch — used to swap hover-only affordances
// for always-visible, tap-sized controls without changing desktop behavior.
export function useIsCoarsePointer() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
