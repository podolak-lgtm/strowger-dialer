import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";

export default function Page() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950">
      <Suspense fallback={null}>
        <SignUp />
      </Suspense>
    </main>
  );
}
