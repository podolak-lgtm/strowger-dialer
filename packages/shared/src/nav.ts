import type { RoleName } from "./roles";

/**
 * The app's left-hand navigation as data (owner, 6 Nov: "as few items on the
 * left as possible, about 7"). Three launchers open their own windows; the
 * rest are sections whose pages share a tab bar across the top. Every tab is
 * an existing page at its existing URL, so links, redirects and
 * revalidatePath calls elsewhere keep working; `?tab=` on a section's root
 * URL is accepted as an alias (`TAB_ALIASES`, wired as redirects in
 * next.config.ts).
 */

/** Who may see an entry: any of `roles` (empty: everyone). ADMIN sees everything. */
type Access = { roles: readonly RoleName[] };

export type NavTab = Access & {
  /** Alias key for `?tab=` on the section root. */
  key: string;
  label: string;
  href: string;
  /** Extra path prefixes that belong to this tab (pages linked from it). */
  also?: readonly string[];
  /** Campaign-scoped: hidden in the bare platform workspace. */
  client?: boolean;
};

export type NavSection = { key: string; label: string; tabs: readonly NavTab[] };

export type NavLauncher = Access & { key: string; label: string; href: string; window: string; client?: boolean };

const SUP = ["SUPERVISOR"] as const;
const SUPERVISING = ["SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER"] as const;
const FLOOR_STAFF = ["AGENT", "TEAM_LEADER", "SUPERVISOR"] as const;

export const NAV_LAUNCHERS: readonly NavLauncher[] = [
  { key: "agent", label: "Agent console", href: "/agent", window: "strowger-agent", roles: ["AGENT", "TEAM_LEADER"], client: true },
  { key: "floor", label: "Floor", href: "/floor", window: "strowger-floor", roles: SUPERVISING, client: true },
  { key: "campaigns", label: "Campaigns", href: "/campaigns", window: "strowger-campaigns", roles: SUP, client: true },
];

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    tabs: [
      { key: "overview", label: "Overview", href: "/dashboard", roles: [], client: true },
      { key: "reports", label: "Reports", href: "/reports", roles: SUPERVISING, client: true },
      { key: "inbound-report", label: "Inbound", href: "/reports/inbound", roles: SUPERVISING, client: true },
    ],
  },
  {
    key: "leads",
    label: "Leads",
    tabs: [
      { key: "find", label: "Find a lead", href: "/leads", roles: SUPERVISING, client: true },
      { key: "lists", label: "Lists", href: "/lists", roles: SUP, client: true },
      { key: "cadences", label: "Cadences", href: "/cadences", roles: SUP, client: true },
      { key: "affiliates", label: "Affiliates", href: "/affiliates", roles: SUP, client: true },
    ],
  },
  {
    key: "numbers",
    label: "Numbers",
    tabs: [
      { key: "numbers", label: "Numbers", href: "/numbers", roles: SUP, client: true },
      { key: "reputation", label: "Reputation", href: "/dids", roles: SUP, client: true },
      { key: "inbound", label: "Inbound routing", href: "/inbound", also: ["/skills"], roles: SUP, client: true },
      { key: "voicemails", label: "Voicemails", href: "/voicemails", roles: FLOOR_STAFF, client: true },
    ],
  },
  {
    key: "compliance",
    label: "Compliance",
    tabs: [{ key: "compliance", label: "Compliance", href: "/compliance", roles: SUP, client: true }],
  },
  {
    key: "people",
    label: "People",
    tabs: [
      { key: "people", label: "People", href: "/people", roles: SUP },
      { key: "teams", label: "Teams & rooms", href: "/teams", roles: SUP, client: true },
      { key: "games", label: "Games", href: "/games", roles: FLOOR_STAFF, client: true },
    ],
  },
  {
    // Placed after the partner portal by visibleNav (it was the last client item before the regroup); never in the platform tenant.
    key: "billing",
    label: "Billing",
    tabs: [
      { key: "billing", label: "Billing", href: "/billing", roles: SUP, client: true },
      { key: "refer", label: "Refer & earn", href: "/refer", roles: SUP, client: true },
    ],
  },
];

/** Who is looking: roles plus the two workspace facts the menu depends on. */
export type NavViewer = {
  roles: readonly RoleName[];
  /** Platform tenant with no client opened: nothing campaign-scoped works there. */
  bare: boolean;
  /** The platform tenant itself (billing is per client). */
  platformTenant: boolean;
  /** The platform owner is inside a client workspace. */
  acting: boolean;
};

function allowed(v: NavViewer, a: Access & { client?: boolean }): boolean {
  if (a.client && v.bare) return false;
  if (v.roles.includes("ADMIN")) return true;
  return a.roles.length === 0 || a.roles.some((r) => v.roles.includes(r));
}

export type VisibleSection = { key: string; label: string; href: string; tabs: Array<Pick<NavTab, "key" | "label" | "href" | "also">> };
export type VisibleNav = {
  launchers: Array<Pick<NavLauncher, "key" | "label" | "href" | "window">>;
  /** Sections and plain links, in sidebar order. A plain link is a section with one tab. */
  items: VisibleSection[];
};

function single(key: string, label: string, href: string): VisibleSection {
  return { key, label, href, tabs: [{ key, label, href }] };
}

/** The tabs of a section this viewer may open. */
export function visibleTabs(v: NavViewer, sectionKey: string): VisibleSection["tabs"] {
  const s = NAV_SECTIONS.find((x) => x.key === sectionKey);
  if (!s) return [];
  return s.tabs.filter((t) => allowed(v, t)).map(({ key, label, href, also }) => ({ key, label, href, also }));
}

/**
 * The sidebar for this viewer. A section whose only visible tab is not its
 * own first page is named after that tab (an agent sees "Voicemails" and "Games", not "Numbers" and
 * "People" holding a single page). The bare platform workspace keeps its
 * short list: Platform, People, Settings.
 */
export function visibleNav(v: NavViewer): VisibleNav {
  const admin = v.roles.includes("ADMIN");
  if (v.bare) {
    return {
      launchers: [],
      items: [single("platform", "Platform", "/platform"), single("people", "People", "/people"), single("settings", "Settings", "/settings")],
    };
  }
  const items: VisibleSection[] = [];
  for (const s of NAV_SECTIONS) {
    if (s.key === "billing") continue;
    const tabs = visibleTabs(v, s.key);
    if (!tabs.length) continue;
    // One tab that is not the section's own page: name the item after it.
    const label = tabs.length === 1 && tabs[0]!.href !== s.tabs[0]!.href ? tabs[0]!.label : s.label;
    items.push({ key: s.key, label, href: tabs[0]!.href, tabs });
  }
  if (v.roles.includes("AFFILIATE")) items.push(single("partner", "Partner portal", "/partner"));
  const billingTabs = v.platformTenant ? [] : visibleTabs(v, "billing");
  if (billingTabs.length) items.push({ key: "billing", label: "Billing", href: "/billing", tabs: billingTabs });
  if (admin && (v.platformTenant || v.acting)) items.push(single("platform", "Platform", "/platform"));
  if (admin) items.push(single("settings", "Settings", "/settings"));
  return {
    launchers: NAV_LAUNCHERS.filter((l) => allowed(v, l)).map(({ key, label, href, window }) => ({ key, label, href, window })),
    items,
  };
}

/** True when `pathname` is `href` or a page under it. */
export function pathWithin(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The tab (and so the section) a path belongs to, if any. The longest matching URL wins (/reports/inbound over /reports). */
export function tabOfPath(tabs: VisibleSection["tabs"], pathname: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const t of tabs) {
    for (const href of [t.href, ...(t.also ?? [])]) {
      if (pathWithin(pathname, href) && (!best || href.length > best.len)) best = { key: t.key, len: href.length };
    }
  }
  return best?.key ?? null;
}

/** `/<section root>?tab=<key>` → the tab's own URL, for every tab that is not the root itself. */
export const TAB_ALIASES: ReadonlyArray<{ source: string; tab: string; destination: string }> = NAV_SECTIONS.flatMap((s) =>
  s.tabs.slice(1).map((t) => ({ source: s.tabs[0]!.href, tab: t.key, destination: t.href })),
);
