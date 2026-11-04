// Self-service callback page, reached from the missed-call text. Public: the
// token in the link is the only credential, and it can only book a callback
// for its own lead.
import { prisma } from "@strowger/db";
import { notFound } from "next/navigation";
import { bookCallback } from "./actions";

export const dynamic = "force-dynamic";

export default async function CallbackPage({ params, searchParams }: PageProps<"/cb/[token]">) {
  const { token } = await params;
  const { done } = await searchParams;
  const lead = await prisma.lead.findUnique({ where: { callbackToken: token }, include: { list: { include: { campaign: true } }, tenant: true, callbacks: { where: { status: "SCHEDULED" }, orderBy: { dueAt: "asc" }, take: 1 } } });
  if (!lead || !lead.list.campaign) notFound();

  const zone = lead.timezone ?? "America/New_York";
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  const booked = done === "1" ? lead.callbacks[0] : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-100">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{lead.tenant.name}</div>
        <h1 className="text-2xl font-semibold">Sorry we missed you{lead.firstName ? `, ${lead.firstName}` : ""}.</h1>
        <p className="mt-1 text-sm text-zinc-400">Pick a time and we&apos;ll call you back at {lead.phone.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}.</p>

        {booked ? (
          <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-200">
            <div className="font-medium">You&apos;re booked.</div>
            <div className="text-sm">We&apos;ll call {fmt(booked.dueAt)} ({zone.replace("_", " ")}).</div>
          </div>
        ) : null}

        <form action={bookCallback} className="mt-5 space-y-3">
          <input type="hidden" name="token" value={token} />
          <div className="grid grid-cols-1 gap-2">
            {(
              [
                ["15m", "In 15 minutes"],
                ["30m", "In 30 minutes"],
                ["tomorrow14", "Tomorrow at 2:00 PM"],
              ] as const
            ).map(([v, label]) => (
              <button key={v} name="when" value={v} className="rounded-xl bg-zinc-100 px-4 py-3 text-left font-medium text-zinc-900 hover:bg-white">
                {label}
              </button>
            ))}
          </div>
          <div className="rounded-xl border border-zinc-800 p-3">
            <label className="block text-xs text-zinc-400">
              Or choose a date and time ({zone.replace("_", " ")})
              <input type="datetime-local" name="custom" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100" />
            </label>
            <button name="when" value="custom" className="mt-2 w-full rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800">
              Book this time
            </button>
          </div>
        </form>
        <p className="mt-4 text-xs text-zinc-500">Reply STOP to any text to opt out of messages.</p>
      </div>
    </main>
  );
}
