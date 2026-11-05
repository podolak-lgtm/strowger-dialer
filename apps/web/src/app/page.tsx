import Link from "next/link";
import { StrowgerComic } from "@/components/strowger-comic";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center gap-14 px-6 py-16 sm:px-10">
      <div className="flex flex-col items-center gap-6 pt-6">
        <h1 className="text-5xl font-semibold tracking-tight">Strowger</h1>
        <p className="max-w-md text-center text-zinc-400">Outbound and inbound contact center. Ratio and preview dialing, texting, and TCPA compliance designed in.</p>
        <div className="flex gap-3">
          <Link href="/sign-in" className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900">
            Sign in
          </Link>
          <Link href="/dashboard" className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium">
            Dashboard
          </Link>
        </div>
      </div>
      <StrowgerComic />
      <p className="max-w-xl text-center text-xs text-zinc-600">
        Almon Brown Strowger (1839–1902) patented the automatic telephone exchange in 1891. Whether the operator really was the rival&apos;s wife is the kind of detail history leaves to the
        storyteller.
      </p>
    </main>
  );
}
