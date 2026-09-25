"use client";

import { Download, RefreshCw, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// The beforeinstallprompt event is not part of the TS DOM lib.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const INSTALL_DISMISS_KEY = "cendro.install-dismissed";

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
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const reloadingForUpdate = useRef(false);

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
    if (localStorage.getItem(INSTALL_DISMISS_KEY) === "1") return;
    const onBeforeInstall = (event: Event) => {
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
    if (!isStandalone() && isIosSafari()) setInstallHint("ios");
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let interval: number | undefined;

    const watch = (worker: ServiceWorker) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) setWaitingWorker(worker);
      });
    };

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (reg.installing) watch(reg.installing);
        if (reg.waiting) setWaitingWorker(reg.waiting);
        reg.addEventListener("updatefound", () => {
          if (reg.installing) watch(reg.installing);
        });
        interval = window.setInterval(() => void reg.update(), 60 * 60 * 1000);
      })
      .catch(() => undefined);

    const onControllerChange = () => {
      if (reloadingForUpdate.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      if (interval !== undefined) window.clearInterval(interval);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  function dismissInstall() {
    localStorage.setItem(INSTALL_DISMISS_KEY, "1");
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

      {(installEvent || installHint || waitingWorker) && (
        <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[80] w-[min(420px,calc(100vw-24px))] -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-xl border border-[var(--hairline-strong)] bg-[var(--surface)] p-3 shadow-[var(--shadow-elevated)]">
            {waitingWorker ? (
              <>
                <RefreshCw className="h-5 w-5 shrink-0 text-[var(--ink-muted)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-[var(--ink)]">Update available</div>
                  <div className="text-[12.5px] text-[var(--ink-muted)]">Reload to use the latest version of Cendro.</div>
                </div>
                <button
                  type="button"
                  className="h-9 shrink-0 rounded-lg bg-[var(--ink)] px-3.5 text-[13px] font-semibold text-[var(--canvas)]"
                  onClick={() => {
                    reloadingForUpdate.current = true;
                    waitingWorker.postMessage({ type: "SKIP_WAITING" });
                  }}
                >
                  Reload
                </button>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
