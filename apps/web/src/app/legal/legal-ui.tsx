// Shared layout for the terms pages under /legal (public).
import type { ReactNode } from "react";
import Link from "next/link";
import { REFERRER_INACTIVE_DAYS } from "@strowger/shared/referrals";

export const REFERRAL_INACTIVE_DAYS_TEXT = String(REFERRER_INACTIVE_DAYS);

export function LegalPage({ title, version, children }: { title: string; version: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        Strowger
      </Link>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Version {version} · effective {new Date(`${version}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}
      </p>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-zinc-300">{children}</div>
    </main>
  );
}

export function Clause({ n, title, id, children }: { n: number; title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="mb-1.5 text-base font-semibold text-zinc-100">
        {n}. {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}
