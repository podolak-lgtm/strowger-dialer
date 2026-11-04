import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { createTenant } from "./actions";

export default async function Onboarding() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  if (await getSession()) redirect("/dashboard");
  const clerk = await currentUser();
  const email = clerk?.primaryEmailAddress?.emailAddress ?? "";

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <form action={createTenant} className="w-full max-w-md space-y-5 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Set up your contact center</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Signed in as {email}. No workspace has invited this address, so create one. You will be its
            administrator.
          </p>
        </div>
        <label className="block text-sm">
          <span className="text-zinc-300">Company name</span>
          <input
            name="name"
            required
            minLength={2}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2"
            placeholder="Acme Contact Center"
          />
        </label>
        <button className="w-full rounded-md bg-zinc-100 px-4 py-2 font-medium text-zinc-900">Create workspace</button>
      </form>
    </main>
  );
}
