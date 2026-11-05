"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const VERSION_POLL_MS = 60_000;

/** The text Next.js puts in the error when a page calls a Server Action from an older build. */
export function isStaleBuildError(message: string): boolean {
  return /was not found on the server/i.test(message);
}

/**
 * Polls /api/version and reports when the server is running a different
 * build than the one that rendered this page. Never reloads by itself: a
 * reload drops the softphone line, so that is the agent's call. `markStale`
 * lets a caller flip the flag from a failed Server Action.
 */
export function useNewVersion(current: string): { stale: boolean; markStale: () => void } {
  const [stale, setStale] = useState(false);
  const markStale = useCallback(() => setStale(true), []);
  const staleRef = useRef(false);
  useEffect(() => {
    staleRef.current = stale;
  }, [stale]);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (staleRef.current || document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { version?: unknown };
        if (!stopped && typeof body.version === "string" && body.version !== current) setStale(true);
      } catch {
        // Offline or deploying: try again next tick.
      }
    };
    const t = setInterval(() => void check(), VERSION_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [current]);

  return { stale, markStale };
}

/**
 * Non-blocking banner: "A new version is ready — reload when you're between
 * calls". `onCall` only changes the wording; the button always works because
 * a stale page cannot do anything else anyway.
 */
export function NewVersionBanner({ show, onCall = false }: { show: boolean; onCall?: boolean }) {
  if (!show) return null;
  return (
    <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-sky-500/40 bg-sky-950/60 px-3 py-2 text-sm text-sky-100">
      <span>
        A new version is ready — reload when you&apos;re between calls.
        {onCall ? <span className="ml-1 text-sky-300/80">Reloading now would drop your line.</span> : null}
      </span>
      <button type="button" onClick={() => window.location.reload()} className="shrink-0 rounded-md bg-sky-400 px-3 py-1 font-medium text-sky-950 hover:bg-sky-300">
        Reload
      </button>
    </div>
  );
}
