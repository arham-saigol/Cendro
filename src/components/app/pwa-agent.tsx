"use client";

import { Download, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";

// The beforeinstallprompt event is not part of the TS DOM lib.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const INSTALL_DISMISS_KEY = "cendro.install-dismissed";

// Storage can be unavailable (private browsing); the install UI must never
// take down the workspace over a persisted dismissal.
function installDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

// The install card is a mobile-only affordance. Chromium is the only engine
// that fires beforeinstallprompt and its userAgentData.mobile flag is the
// usual signal — but Android tablets can report mobile:false, so a mobile UA
// token still counts even when the hint is false or absent.
export function isMobileUserAgent(userAgent: string, uaDataMobile?: boolean): boolean {
  if (uaDataMobile === true) return true;
  return /android|iphone|ipod|mobile/i.test(userAgent);
}

function isMobile() {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  return isMobileUserAgent(navigator.userAgent, uaData?.mobile);
}

function isIosSafari() {
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // iOS Safari does not fire beforeinstallprompt; other iOS browsers share its engine.
  return isIos && !(navigator as Navigator & { standalone?: boolean }).standalone;
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function PwaAgent() {
  const [online, setOnline] = useState(true);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installHint, setInstallHint] = useState<"ios" | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (installDismissed() || isStandalone()) return;
    const onBeforeInstall = (event: Event) => {
      // Desktop Chromium fires beforeinstallprompt too: leave its built-in
      // affordance alone and only offer our card on mobile. Re-check
      // standalone at event time — the display-mode can lag mount in a
      // freshly installed PWA window.
      if (!isMobile() || isStandalone()) return;
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallEvent(null);
      setInstallHint(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    // iOS never fires beforeinstallprompt; offer the manual share-menu route once.
    if (isIosSafari()) setInstallHint("ios");
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Register the service worker and keep checking for updates. A new worker
  // waits until every Cendro tab closes, then activates on the next open —
  // updates land on a natural reload or relaunch, never a forced one.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let interval: number | undefined;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        interval = window.setInterval(() => void reg.update(), 60 * 60 * 1000);
      })
      .catch(() => undefined);

    return () => {
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  function dismissInstall() {
    try {
      localStorage.setItem(INSTALL_DISMISS_KEY, "1");
    } catch {
      // Dismissal still applies for this mount.
    }
    setInstallEvent(null);
    setInstallHint(null);
  }

  return (
    <>
      {!online && (
        <div role="status" className="fixed left-1/2 top-[calc(0.75rem+env(safe-area-inset-top))] z-[80] flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--hairline-strong)] bg-[var(--surface)] px-4 py-2 text-[13px] font-medium text-[var(--ink)] shadow-[var(--shadow-elevated)]">
          <WifiOff className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
          <span>You&rsquo;re offline — reconnect to keep working</span>
        </div>
      )}

      {(installEvent || installHint) && (
        <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[80] w-[min(420px,calc(100vw-24px))] -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-xl border border-[var(--hairline-strong)] bg-[var(--surface)] p-3 shadow-[var(--shadow-elevated)]">
            <Download className="h-5 w-5 shrink-0 text-[var(--ink-muted)]" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[var(--ink)]">Install Cendro</div>
              <div className="text-[12.5px] text-[var(--ink-muted)]">
                {installHint === "ios" ? "Open the Share menu and choose “Add to Home Screen”." : "Add Cendro to your home screen for quick access."}
              </div>
            </div>
            {installEvent && (
              <button
                type="button"
                className="h-9 shrink-0 rounded-lg bg-[var(--ink)] px-3.5 text-[13px] font-semibold text-[var(--canvas)]"
                onClick={() => {
                  void installEvent.prompt().then(() => setInstallEvent(null));
                }}
              >
                Install
              </button>
            )}
            <button type="button" aria-label="Dismiss install prompt" className="task-icon-btn h-9 w-9 shrink-0" onClick={dismissInstall}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
