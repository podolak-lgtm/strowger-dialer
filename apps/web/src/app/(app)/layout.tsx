import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { NavLink } from "@/components/nav-link";
import { hasRole, isBarePlatform, requireSession } from "@/lib/auth";
import { billingStatus } from "@/lib/billing-actions";
import { BillingBadge } from "@/components/billing-badge";
import { leaveWorkspace } from "@/lib/billing-actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();
  // The owner's own workspace holds no campaigns: with no client opened,
  // every campaign-scoped page is blank, so the nav shows only what works
  // there (owner, 5 Nov: opened Campaigns, saw nothing, thought it broke).
  const bare = isBarePlatform(session);
  const acting = session.actingFrom ?? null;
  const billing = hasRole(session, "SUPERVISOR") && !bare ? await billingStatus() : null;
  const nav: Array<{ href: string; label: string; show: boolean }> = bare
    ? [
        { href: "/platform", label: "Platform", show: true },
        { href: "/people", label: "People", show: true },
        { href: "/settings", label: "Settings", show: true },
      ]
    : [
        { href: "/dashboard", label: "Dashboard", show: true },
        { href: "/agent", label: "Agent", show: hasRole(session, "AGENT", "TEAM_LEADER") },
        { href: "/floor", label: "Floor", show: hasRole(session, "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER") },
        { href: "/campaigns", label: "Campaigns", show: hasRole(session, "SUPERVISOR") },
        { href: "/lists", label: "Lists", show: hasRole(session, "SUPERVISOR") },
        { href: "/cadences", label: "Cadences", show: hasRole(session, "SUPERVISOR") },
        { href: "/affiliates", label: "Affiliates", show: hasRole(session, "SUPERVISOR") },
        { href: "/compliance", label: "Compliance", show: hasRole(session, "SUPERVISOR") },
        { href: "/dids", label: "DIDs", show: hasRole(session, "SUPERVISOR") },
        { href: "/numbers", label: "Numbers", show: hasRole(session, "SUPERVISOR") },
        { href: "/inbound", label: "Inbound", show: hasRole(session, "SUPERVISOR") },
        { href: "/voicemails", label: "Voicemails", show: hasRole(session, "AGENT", "TEAM_LEADER", "SUPERVISOR") },
        { href: "/games", label: "Games", show: hasRole(session, "AGENT", "TEAM_LEADER", "SUPERVISOR") },
        { href: "/leads", label: "Find a lead", show: hasRole(session, "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER") },
        { href: "/reports", label: "Reports", show: hasRole(session, "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER") },
        { href: "/people", label: "People", show: hasRole(session, "SUPERVISOR") },
        { href: "/teams", label: "Teams & rooms", show: hasRole(session, "SUPERVISOR") },
        { href: "/partner", label: "Partner portal", show: session.roles.includes("AFFILIATE") },
        { href: "/billing", label: "Billing", show: hasRole(session, "SUPERVISOR") && !session.tenant.isPlatform },
        { href: "/platform", label: "Platform", show: hasRole(session) && (session.tenant.isPlatform || Boolean(acting)) },
        { href: "/settings", label: "Settings", show: hasRole(session) },
      ];
  return (
    <div className="flex min-h-screen flex-col">
      {acting ? (
        // Full-width band above everything: the owner is inside a client and must never mistake it for their own workspace.
        <header data-app-band className="sticky top-0 z-30 border-b-2 border-sky-400 bg-gradient-to-r from-sky-900 via-sky-800 to-sky-900 text-sky-50 shadow-lg shadow-sky-950/50">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-300">Working in client workspace</div>
              <div className="truncate text-2xl font-semibold leading-tight tracking-tight text-white">{session.tenant.name}</div>
              <div className="mt-0.5 text-xs text-sky-200/80">Everything you do here belongs to this client. You are signed in from {acting.name}.</div>
            </div>
            <div className="flex items-center gap-3">
              {billing ? (
                <div className="w-56">
                  <BillingBadge b={billing} compact />
                </div>
              ) : null}
              <form action={leaveWorkspace}>
                <button type="submit" className="rounded-md border border-sky-300/60 bg-sky-950/60 px-4 py-2 text-sm font-medium text-white hover:bg-sky-950">
                  ← Back to platform
                </button>
              </form>
            </div>
          </div>
        </header>
      ) : null}
      {/* Narrow screens: the sidebar folds into a menu so nothing scrolls sideways. */}
      <details className="border-b border-zinc-800 bg-zinc-900/60 md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm">
          <span className="text-lg font-semibold tracking-tight">Strowger</span>
          <span className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300">Menu</span>
        </summary>
        <nav className="flex flex-wrap gap-1 px-3 pb-3 text-sm">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <NavLink key={n.href} href={n.href} className="rounded-md px-2.5 py-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white">
                {n.label}
              </NavLink>
            ))}
        </nav>
      </details>
      <div className="flex flex-1">
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-900/60 p-4 md:flex">
          <Link href={bare ? "/platform" : "/dashboard"} className="mb-4 text-lg font-semibold tracking-tight">
            Strowger
          </Link>
          <nav className="flex flex-1 flex-col gap-0.5 text-sm">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <NavLink key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white">
                  {n.label}
                </NavLink>
              ))}
            {bare ? <p className="mt-2 rounded-md border border-dashed border-zinc-700 px-3 py-2 text-xs leading-relaxed text-zinc-500">Pick a client under Platform to work on their campaigns, lists and numbers.</p> : null}
          </nav>
          {billing && !acting ? <BillingBadge b={billing} /> : null}
          <div className="mt-4 flex items-center gap-3 border-t border-zinc-800 pt-4">
            <UserButton />
            <div className="min-w-0 text-xs">
              <div className="truncate font-medium">{session.user.firstName ?? session.user.email}</div>
              {acting ? (
                <>
                  <div className="truncate font-medium text-sky-300">{session.tenant.name}</div>
                  <div className="truncate text-zinc-500">via {acting.name}</div>
                </>
              ) : (
                <div className="truncate text-zinc-500">{session.tenant.name}</div>
              )}
            </div>
          </div>
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
