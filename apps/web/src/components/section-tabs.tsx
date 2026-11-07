"use client";

import { usePathname } from "next/navigation";
import { tabOfPath, type VisibleSection } from "@strowger/shared/nav";
import { NavLink } from "@/components/nav-link";

/**
 * The tab bar across the top of a section (Leads, Numbers, People, …): the
 * campaign page's look, but each tab is its own page and URL, so it is a
 * link, not a client-side switch. Wraps on narrow screens. `marks` adds a
 * sign after a tab's label (Carrier setup ✓).
 */
export function SectionTabs({ label, tabs, marks }: { label: string; tabs: VisibleSection["tabs"]; marks?: Record<string, string> }) {
  const pathname = usePathname();
  const active = tabOfPath(tabs, pathname);
  return (
    <nav aria-label={label} data-section-tabs className="-mt-1 mb-6 flex flex-wrap gap-x-1 border-b border-zinc-800">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <NavLink
            key={t.key}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={`-mb-px border-b-2 px-2.5 py-2 text-sm ${on ? "border-sky-400 font-medium text-sky-500" : "border-transparent text-zinc-400 hover:text-zinc-500"}`}
          >
            {t.label}
            {marks?.[t.key] ? <span className="ml-1 text-emerald-400">{marks[t.key]}</span> : null}
          </NavLink>
        );
      })}
    </nav>
  );
}
