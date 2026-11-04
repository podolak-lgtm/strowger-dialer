import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { hasRole, requireSession } from "@/lib/auth";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();
  const nav: Array<{ href: string; label: string; show: boolean }> = [
    { href: "/dashboard", label: "Dashboard", show: true },
    { href: "/agent", label: "Agent", show: hasRole(session, "AGENT", "TEAM_LEADER") },
    { href: "/floor", label: "Floor", show: hasRole(session, "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER") },
    { href: "/campaigns", label: "Campaigns", show: hasRole(session, "SUPERVISOR") },
    { href: "/lists", label: "Lists", show: hasRole(session, "SUPERVISOR") },
    { href: "/affiliates", label: "Affiliates", show: hasRole(session, "SUPERVISOR") },
    { href: "/compliance", label: "Compliance", show: hasRole(session, "SUPERVISOR") },
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
        <div className="mt-4 flex items-center gap-3 border-t border-zinc-800 pt-4">
          <UserButton />
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{session.user.firstName ?? session.user.email}</div>
            <div className="truncate text-zinc-500">{session.tenant.name}</div>
          </div>
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
