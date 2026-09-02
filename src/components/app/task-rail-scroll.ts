"use client";

import { useCallback, useEffect, type RefObject } from "react";

export type TaskRailScrollOptions = {
  railRef: RefObject<HTMLElement | null>;
  activeCompanyId?: string | null;
  canUseAllTasks: boolean;
  effectiveTaskView: "all" | "my";
  activeView: string;
  ownFilterCount: number;
};

export function syncToggleScrollState(node: HTMLElement | null) {
  if (!node) return;
  const maxScroll = node.scrollWidth - node.clientWidth;
  node.dataset.scrollStart = node.scrollLeft > 1 ? "true" : "false";
  node.dataset.scrollEnd = maxScroll > 1 && node.scrollLeft < maxScroll - 1 ? "true" : "false";
}

export function scrollActivePillIntoView(rail: HTMLElement | null) {
  const pill = rail?.querySelector<HTMLElement>('[data-active="true"]');
  if (!rail || !pill) return;
  const railBox = rail.getBoundingClientRect();
  const pillBox = pill.getBoundingClientRect();
  if (pillBox.left < railBox.left) rail.scrollLeft -= railBox.left - pillBox.left;
  else if (pillBox.right > railBox.right) rail.scrollLeft += pillBox.right - railBox.right;
}

export function useTaskRailAutoScroll({
  railRef,
  activeCompanyId,
  canUseAllTasks,
  effectiveTaskView,
  activeView,
  ownFilterCount,
}: TaskRailScrollOptions) {
  const syncState = useCallback(() => {
    syncToggleScrollState(railRef.current);
  }, [railRef]);

  const scrollActive = useCallback(() => {
    scrollActivePillIntoView(railRef.current);
  }, [railRef]);

  useEffect(() => {
    scrollActive();
    syncState();
    const node = railRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      scrollActive();
      syncState();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollActive, syncState, railRef, activeCompanyId, canUseAllTasks, effectiveTaskView, ownFilterCount]);

  useEffect(() => {
    scrollActive();
    syncState();
  }, [scrollActive, syncState, activeCompanyId, activeView, effectiveTaskView, ownFilterCount]);

  return { syncToggleScrollState: syncState, scrollActivePillIntoView: scrollActive };
}
