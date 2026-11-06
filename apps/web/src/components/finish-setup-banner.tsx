"use client";

// "Finish setup" (onboarding wizard, owner 6 Nov): above every page for a
// client admin until the wizard is complete or they press Finish. Hidden on
// /welcome itself.
import Link from "next/link";
import { usePathname } from "next/navigation";

export function FinishSetupBanner({ done, total, missingRequired }: { done: number; total: number; missingRequired: string[] }) {
  const path = usePathname();
  if (path.startsWith("/welcome")) return null;
  return (
    <div className="border-b border-sky-900 bg-sky-950/50 px-4 py-2 text-sm text-sky-100 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <b>Finish setting up your workspace:</b> {done} of {total} steps done.
          {missingRequired.length ? ` We still need your ${missingRequired.join(" and ")}.` : " Texting registration, your leads file, your team and your first payment get you live in about 7 days."}
        </span>
        <Link href="/welcome" className="rounded-md bg-sky-400 px-3 py-1 text-xs font-semibold text-zinc-950 hover:bg-sky-300">
          Finish setup →
        </Link>
      </div>
    </div>
  );
}
