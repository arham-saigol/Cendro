"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export const DETAIL_DRAWER_CLOSE_MS = 160;
const DETAIL_DRAWER_CLOSE_EVENT = "cendro:detail-drawer-close";

type DetailDrawerCloseEvent = CustomEvent<{ base: string }>;

export function requestDetailDrawerClose(base: string) {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent(DETAIL_DRAWER_CLOSE_EVENT, { detail: { base }, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function useDetailDrawerClose(base: string, isOpen: boolean, selectedDetailId: string | null | undefined) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current == null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const close = useCallback((target = base) => {
    clearTimer();
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      router.push(target);
    }, DETAIL_DRAWER_CLOSE_MS);
  }, [base, clearTimer, router]);

  useEffect(() => {
    function onClose(event: Event) {
      const closeEvent = event as DetailDrawerCloseEvent;
      if (closeEvent.detail?.base !== base) return;
      event.preventDefault();
      close(closeEvent.detail.base);
    }

    window.addEventListener(DETAIL_DRAWER_CLOSE_EVENT, onClose);
    return () => window.removeEventListener(DETAIL_DRAWER_CLOSE_EVENT, onClose);
  }, [base, close]);

  useEffect(() => {
    if (isOpen) return;
    clearTimer();
    setClosing(false);
  }, [clearTimer, isOpen]);

  useEffect(() => {
    clearTimer();
    setClosing(false);
  }, [clearTimer, selectedDetailId]);

  useEffect(() => clearTimer, [clearTimer]);

  return { closing, close };
}
