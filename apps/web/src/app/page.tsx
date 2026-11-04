import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-5xl font-semibold tracking-tight">Strowger</h1>
      <p className="max-w-md text-center text-zinc-400">
        Outbound contact center. Ratio and preview dialing, texting, and TCPA compliance designed in.
      </p>
      <div className="flex gap-3">
        <Link href="/sign-in" className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900">
          Sign in
        </Link>
        <Link href="/dashboard" className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium">
          Dashboard
        </Link>
      </div>
    </main>
  );
}
