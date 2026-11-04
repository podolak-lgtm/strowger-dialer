// Full-bleed layout for the agent console: no admin sidebar, the console
// draws its own rail. Session is still required.
import { requireSession } from "@/lib/auth";

export default async function ConsoleLayout({ children }: LayoutProps<"/">) {
  await requireSession();
  return <div className="min-h-screen bg-[#070b1a] text-zinc-100">{children}</div>;
}
