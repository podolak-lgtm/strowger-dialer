"use client";

import type { MouseEvent, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { tabOfPath, type VisibleNav } from "@strowger/shared/nav";
import { NavLink } from "@/components/nav-link";
import { confirmLeave } from "@/lib/leave-guard";

const POPUP = "popup=yes,width=1440,height=900";

/**
 * Open a launcher in its own named window, or bring that window forward if
 * it is already open (without reloading it: an agent mid-call or a campaign
 * with unsaved edits stays as it is). Middle-click, cmd/ctrl/shift-click
 * fall through to the browser, so a tab can still be opened the usual way.
 */
function openWindow(e: MouseEvent<HTMLAnchorElement>, href: string, name: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  // Already this window (the Campaigns window's own sidebar): just go there.
  if (window.name === name) {
    if (confirmLeave()) window.location.assign(href);
    return;
  }
  // "" returns the existing window of that name untouched, or a blank new one.
  const w = window.open("", name, POPUP);
  if (!w) {
    // Popup blocked: open it here instead of doing nothing.
    if (confirmLeave()) window.location.assign(href);
    return;
  }
  let blank = true;
  try {
    blank = w.location.href === "about:blank";
  } catch {
    blank = true;
  }
  if (blank) w.location.href = href;
  w.focus();
}

function WindowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The left-hand menu: window launchers on top, then the sections. `compact` is the phone menu. */
export function AppNav({ nav, compact = false, footer }: { nav: VisibleNav; compact?: boolean; footer?: ReactNode }) {
  const pathname = usePathname();
  return (
    <nav aria-label={compact ? "Main menu" : "Main"} className={compact ? "flex flex-col gap-3 px-3 pb-3 text-sm" : "flex flex-1 flex-col gap-0.5 text-sm"}>
      {nav.launchers.length ? (
        <div data-launchers className={compact ? "flex flex-wrap gap-2" : "mb-4 flex flex-col gap-1.5"}>
          {nav.launchers.map((l) => (
            <a
              key={l.key}
              href={l.href}
              target={l.window}
              data-launcher={l.key}
              title={`${l.label} opens in its own window`}
              onClick={(e) => openWindow(e, l.href, l.window)}
              className="flex items-center justify-between gap-2 rounded-md border border-sky-700/60 bg-sky-950/40 px-3 py-1.5 font-medium text-sky-100 hover:border-sky-500 hover:bg-sky-900/50"
            >
              <span>{l.label}</span>
              <WindowIcon />
            </a>
          ))}
        </div>
      ) : null}
      <div className={compact ? "flex flex-wrap gap-1" : "flex flex-col gap-0.5"}>
        {nav.items.map((i) => {
          const on = tabOfPath(i.tabs, pathname) !== null;
          return (
            <NavLink
              key={i.key}
              href={i.href}
              aria-current={on ? "page" : undefined}
              className={`rounded-md ${compact ? "px-2.5" : "px-3"} py-1.5 ${on ? "bg-zinc-800 font-medium text-white" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"}`}
            >
              {i.label}
            </NavLink>
          );
        })}
      </div>
      {footer}
    </nav>
  );
}
