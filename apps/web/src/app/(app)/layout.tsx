import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { visibleNav } from "@strowger/shared/nav";
import { AppNav } from "@/components/app-nav";
import { hasRole, isBarePlatform, navViewer, requireSession } from "@/lib/auth";
import { billingStatus } from "@/lib/billing-actions";
import { BillingBadge } from "@/components/billing-badge";
import { leaveWorkspace } from "@/lib/billing-actions";
import { TrialBanner } from "@/components/trial-banner";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();
  // The owner's own workspace holds no campaigns: with no client opened,
  // every campaign-scoped page is blank, so the nav shows only what works
  // there (owner, 5 Nov: opened Campaigns, saw nothing, thought it broke).
  const bare = isBarePlatform(session);
  const acting = session.actingFrom ?? null;
  const billing = hasRole(session, "SUPERVISOR") && !bare ? await billingStatus() : null;
  const nav = visibleNav(navViewer(session));
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
      {billing ? <TrialBanner tenant={session.tenant} billing={billing} now={new Date()} /> : null}
      {/* Narrow screens: the sidebar folds into a menu so nothing scrolls sideways. */}
      <details className="border-b border-zinc-800 bg-zinc-900/60 md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm">
          <span className="text-lg font-semibold tracking-tight">Strowger</span>
          <span className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300">Menu</span>
        </summary>
        <AppNav nav={nav} compact />
      </details>
      <div className="flex flex-1">
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-900/60 p-4 md:flex">
          <Link href={bare ? "/platform" : "/dashboard"} className="mb-4 text-lg font-semibold tracking-tight">
            Strowger
          </Link>
          <AppNav
            nav={nav}
            footer={bare ? <p className="mt-2 rounded-md border border-dashed border-zinc-700 px-3 py-2 text-xs leading-relaxed text-zinc-500">Pick a client under Platform to work on their campaigns, lists and numbers.</p> : null}
          />
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
