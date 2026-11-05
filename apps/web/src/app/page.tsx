import { existsSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { StrowgerComic } from "@/components/strowger-comic";

// The illustrated comic (owner's artwork) lives at public/strowger-comic.jpg
// when present; until then the drawn strip stands in.
const COMIC = ["strowger-comic.jpg", "strowger-comic.png", "strowger-comic.webp"].find((f) => existsSync(path.join(process.cwd(), "public", f)));

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
      {COMIC ? (
        <section className="w-full max-w-6xl">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-[#c8472b]">Why it is called Strowger</div>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">Kansas City, 1888</h2>
            </div>
          </div>
          <div className="rounded-sm border-[3px] border-[#1b1b1f] bg-[#f6efe0] p-2 shadow-[8px_8px_0_#000]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/${COMIC}`} alt="The story of Almon B. Strowger, the undertaker who invented the automatic telephone exchange out of spite" className="block h-auto w-full" />
          </div>
          <p className="mt-4 border-l-[3px] border-[#c8472b] pl-3 text-base text-zinc-200">
            <b className="text-zinc-100">There is nothing more American than inventing something out of spite.</b> This dialer carries his name: no operator in the middle, your calls go where you
            send them.
          </p>
        </section>
      ) : (
        <StrowgerComic />
      )}
      <p className="max-w-xl text-center text-xs text-zinc-600">Almon Brown Strowger (1839–1902) patented the automatic telephone exchange in 1891; the first exchange opened in La Porte, Indiana, in 1892.</p>
    </main>
  );
}
