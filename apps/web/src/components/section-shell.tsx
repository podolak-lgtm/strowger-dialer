import type { ReactNode } from "react";
import { NAV_SECTIONS, visibleTabs } from "@strowger/shared/nav";
import { navViewer, requireSession } from "@/lib/auth";
import { SectionTabs } from "@/components/section-tabs";

/**
 * Layout for every page of a section: the section's tab bar (only the tabs
 * this person may open; none when that is a single tab) over the page,
 * which renders exactly as it did on its own. Used by a one-line
 * `layout.tsx` in each tab's folder, so URLs and pages stay where they were.
 */
export async function SectionShell({ section, children }: { section: string; children: ReactNode }) {
  const session = await requireSession();
  const tabs = visibleTabs(navViewer(session), section);
  const label = NAV_SECTIONS.find((s) => s.key === section)?.label ?? section;
  return (
    <>
      {tabs.length > 1 ? <SectionTabs label={label} tabs={tabs} /> : null}
      {children}
    </>
  );
}
