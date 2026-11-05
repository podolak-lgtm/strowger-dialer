import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { hasRole, requireSession } from "@/lib/auth";
import { billingStatus } from "@/lib/billing-actions";
import { BillingBadge } from "@/components/billing-badge";
import { leaveWorkspace } from "@/lib/billing-actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();
  const billing = hasRole(session, "SUPERVISOR") ? await billingStatus() : null;
  const nav: Array<{ href: string; label: string; show: boolean }> = [
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
    { href: "/platform", label: "Platform", show: hasRole(session) && (session.tenant.isPlatform || Boolean(session.actingFrom)) },
    { href: "/settings", label: "Settings", show: hasRole(session) },
  ];
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r border-zinc-800 bg-zinc-900/60 p-4">
        <Link href="/dashboard" className="mb-6 text-lg font-semibold tracking-tight">
          Strowger
        </Link>
        <nav className="flex flex-1 flex-col gap-1 text-sm">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <Link key={n.href} href={n.href} className="rounded-md px-3 py-2 text-zinc-300 hover:bg-zinc-800 hover:text-white">
                {n.label}
              </Link>
            ))}
        </nav>
        {hasRole(session, "SUPERVISOR") ? <BillingBadge b={billing} /> : null}
        <div className="mt-4 flex items-center gap-3 border-t border-zinc-800 pt-4">
          <UserButton />
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{session.user.firstName ?? session.user.email}</div>
            <div className="truncate text-zinc-500">{session.tenant.name}</div>
          </div>
        </div>
      </aside>
      <main className="flex-1 p-8">
        {session.actingFrom ? (
          <div className="mb-4 flex items-center justify-between rounded-md border border-fuchsia-500/40 bg-fuchsia-950/40 px-3 py-2 text-xs text-fuchsia-100">
            <span>
              Working inside <b>{session.tenant.name}</b> as platform admin. Everything you do here belongs to that client.
            </span>
            <form action={leaveWorkspace}>
              <button type="submit" className="rounded border border-fuchsia-400/40 px-2 py-0.5 hover:bg-fuchsia-500/20">
                Back to {session.actingFrom.name}
              </button>
            </form>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
